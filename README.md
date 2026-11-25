# TruFind Backend

Backend API for the TruFind lost-and-found web application.

Features:
- User authentication
- Email verification
- Image uploads
- PostgreSQL database integration

Tech Stack:
Node.js, Express, PostgreSQL

Set `AUTH_TOKEN_SECRET` before starting the backend. Use a private value
generated from at least 32 random bytes. Use a different value in each
environment and keep it out of Git. Changing it invalidates existing tokens.
Login tokens expire after one hour.

## Image storage

Set `AWS_REGION=us-east-1` and `S3_BUCKET=trufind-images-shraf2004-20261121`
using the environment for the backend service. Use Node.js 22 or later.
Attach the `TruFindEC2Role` instance profile to EC2. The AWS SDK uses its
default credential provider chain. Keep S3 Block Public Access enabled and
grant only `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on
`arn:aws:s3:::trufind-images-shraf2004-20261121/posts/*`.

Uploads accept JPEG, PNG, and WebP up to 5 MiB. In the Nginx server or
location block that proxies `POST /posts`, set `client_max_body_size 6m;`
to allow room for multipart overhead. Validate the Nginx config with
`nginx -t` before reloading it.

The existing `image_url` column stores S3 references. Both post feeds
return fresh 15-minute HTTPS links for those references and continue to
return existing Cloudinary URLs. The bucket stays private, but anyone
with a valid signed link can load its image while the link is active.
If S3 cleanup fails after a deletion or failed insert, the backend logs
the object reference for follow-up.

Run the isolated API tests with `node --test` after installing
dependencies with `npm ci`. The tests use fake PostgreSQL, email, and S3
services.
