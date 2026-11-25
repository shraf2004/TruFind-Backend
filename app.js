const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const multer = require("multer");
const { isSupportedImage } = require("./image-storage");
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

function createApp({ pool, nodemailer, images }) {
    const { issueToken, requireUser } = require("./auth");
    //   Setup Express
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: MAX_IMAGE_SIZE + 1 }
    }).single("image");

    function parseImage(req, res, next) {
        upload(req, res, error => {
            if (error?.code === "LIMIT_FILE_SIZE" || req.file?.size > MAX_IMAGE_SIZE) {
                return res.status(413).json({ success: false, message: "Images must be 5 MiB or smaller." });
            }
            if (error) return res.status(400).json({ success: false, message: "Invalid image upload." });
            return next();
        });
    }

    async function removeImage(reference, reason) {
        try {
            await images.remove(reference);
        } catch {
            console.error("S3 image cleanup failed", { reason, reference });
        }
    }

    //   Generate 6-digit Code
    function genCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    //   Send Email Verification Code
    app.post("/send-code", (req, res) => {
        const { email, name, password } = req.body;
        if (!email.endsWith("@truman.edu")) {
            return res.json({ success: false, message: "Only Truman email allowed." });
        }

        const code = genCode();

        // Check if user already verified
        const checkSQL = "SELECT * FROM users WHERE email = $1";
        pool.query(checkSQL, [email], (err, result) => {
            if (err) return res.json({ success: false, message: "Database error" });

            const existingUser = result.rows[0];

            if (existingUser && existingUser.is_verified) {
                return res.json({ success: false, message: "Email is already registered." });
            }

            // Not verified yet — insert or update
            bcrypt.hash(password, 10, (err, hashedPassword) => {
                if (err) return res.json({ success: false, message: "Password error" });

                const sql = `INSERT INTO users (name, email, password, verification_code, is_verified)
                             VALUES ($1, $2, $3, $4, false)
                             ON CONFLICT (email) DO UPDATE
                             SET name = EXCLUDED.name, password = EXCLUDED.password, verification_code = EXCLUDED.verification_code, is_verified = false`;

                pool.query(sql, [name, email, hashedPassword, code], (err) => {
                    if (err) return res.json({ success: false, message: "Database error" });

                    const transporter = nodemailer.createTransport({
                        service: "gmail",
                        auth: {
                            user: process.env.GMAIL_USER,
                            pass: process.env.GMAIL_PASS
                        }
                    });

                    const mailOptions = {
                        from: process.env.GMAIL_USER,
                        to: email,
                        subject: "Your TruFind Verification Code",
                        text: `Your verification code is: ${code}`
                    };

                    transporter.sendMail(mailOptions, (err) => {
                        if (err) return res.json({ success: false, message: "Email error" });
                        return res.json({ success: true });
                    });
                });
            });
        });
    });


    //   Verify Code
    app.post("/verify-code", (req, res) => {
        const { email, code } = req.body;
        const sql = "SELECT * FROM users WHERE email=$1 AND verification_code=$2";
        pool.query(sql, [email, code], (err, result) => {
            if (err || result.rows.length === 0) {
                return res.json({ success: false, message: "Invalid code or email" });
            }

            const updateSQL = `UPDATE users SET is_verified = true, verification_code = NULL WHERE email = $1`;
            pool.query(updateSQL, [email], (err) => {
                if (err) return res.json({ success: false, message: "Failed to verify" });
                return res.json({ success: true });
            });
        });
    });

    //   Create Post
    app.post("/posts", requireUser, parseImage, async (req, res) => {
        let imageUrl = "No image";
        try {
            const userId = req.userId;
            const title = req.body.title;
            const description = req.body.description;
            const file = req.file;

            if (file) {
                if (!await isSupportedImage(file)) {
                    return res.status(400).json({
                        success: false,
                        message: "Upload a JPEG, PNG, or WebP image with a matching file type."
                    });
                }
                imageUrl = await images.upload(file);
            }

            const sql = `INSERT INTO posts (user_id, title, description, image_url, created_at)
                         VALUES ($1, $2, $3, $4, NOW())`;

            await pool.query(sql, [userId, title, description, imageUrl]);
        } catch {
            if (imageUrl !== "No image") await removeImage(imageUrl, "post insert failed");
            return res.status(500).json({ success: false, message: "Could not save the post." });
        }
        return res.json({ success: true });
    });

    async function sendPosts(res, sql, params) {
        res.set("Cache-Control", "no-store");
        try {
            const result = await pool.query(sql, params);
            const posts = await Promise.all(result.rows.map(async post => ({
                ...post,
                image_url: await images.readUrl(post.image_url)
            })));
            return res.json({ success: true, posts });
        } catch {
            return res.status(500).json({ success: false, message: "Could not load posts." });
        }
    }

    //   Get Posts by user_id
    app.get("/posts/:user_id", (req, res) => {
        const userId = req.params.user_id;
        const sql = "SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC";
        return sendPosts(res, sql, [userId]);
    });

    //   Get All Posts with user name
    app.get("/all-posts", (req, res) => {
        const sql = `SELECT posts.*, users.name FROM posts JOIN users ON posts.user_id = users.id ORDER BY created_at DESC`;
        return sendPosts(res, sql, []);
    });

    //   Delete Post
    app.delete("/delete-posts/:id", requireUser, async (req, res) => {
        const postId = req.params.id;
        const userId = req.userId;
        const sql = "DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING image_url";
        let result;
        try {
            result = await pool.query(sql, [postId, userId]);
        } catch {
            return res.status(500).json({ success: false });
        }
        if (!result.rowCount) return res.status(404).json({ success: false });
        await removeImage(result.rows[0].image_url, "post deleted");
        return res.json({ success: true });
    });

    //   Start Server
    app.get("/health", (req, res) => {
        res.status(200).json({
          status: "ok",
          service: "trufind-backend"
        });
      });


    //   Login Route
    app.post("/login", (req, res) => {
        const { email, password } = req.body;

        // 1. Find the user with matching email and verified status
        const sql = "SELECT * FROM users WHERE email = $1 AND is_verified = true";
        pool.query(sql, [email], (err, result) => {
            if (err) {
                console.error("DB error during login:", err);
                return res.json({ success: false, message: "Database error" });
            }

            if (result.rows.length === 0) {
                return res.json({ success: false, message: "User not found or not verified" });
            }

            const user = result.rows[0];

            // 2. Compare password
            bcrypt.compare(password, user.password, (err, match) => {
                if (err || !match) {
                    return res.json({ success: false, message: "Invalid password" });
                }

                return res.json({ success: true, id: user.id, name: user.name, ...issueToken(user.id) });
            });
        });
    });

    return app;
}

module.exports = createApp;
