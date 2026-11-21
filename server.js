require("dotenv").config();
require("./auth");

const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const cloudinary = require("cloudinary").v2;
const createApp = require("./app");

//   Setup PostgreSQL
const pool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: {
    ca: require("fs").readFileSync(
      require("path").join(__dirname, "global-bundle.pem"), "utf8"
    ),
    rejectUnauthorized: true
  }
});

//   Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = createApp({ pool, nodemailer, cloudinary });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
