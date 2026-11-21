require("dotenv").config();
require("./auth");

const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const { S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const createApp = require("./app");
const { createImageStorage } = require("./image-storage");

const region = process.env.AWS_REGION;
if (!region) throw new Error("AWS_REGION is required");
const images = createImageStorage({
    bucket: process.env.S3_BUCKET,
    client: new S3Client({ region }),
    signUrl: getSignedUrl
});

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

const app = createApp({ pool, nodemailer, images });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
