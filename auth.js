const { createHmac, timingSafeEqual } = require("node:crypto");

const secret = process.env.AUTH_TOKEN_SECRET;
if (!secret?.trim()) throw new Error("AUTH_TOKEN_SECRET is required");

function signature(payload) {
    return createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueToken(userId) {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const payload = `${userId}.${expiresAt}`;
    return { token: `${payload}.${signature(payload)}`, expiresAt };
}

function requireUser(req, res, next) {
    const match = /^Bearer ([1-9]\d*)\.(\d{13})\.([A-Za-z0-9_-]{43})$/i
        .exec(req.get("Authorization") || "");

    if (match) {
        const [, userId, expiresAt, supplied] = match;
        const expected = signature(`${userId}.${expiresAt}`);
        if (timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) && Number(expiresAt) > Date.now()) {
            req.userId = userId;
            return next();
        }
    }

    return res.status(401).json({ success: false, message: "Please log in again." });
}

module.exports = { issueToken, requireUser };
