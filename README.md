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

## Docker and CI

From the backend directory, build and run the isolated API tests with
container networking limited to loopback.

```sh
docker build --target test -t trufind-backend:test .
docker run --rm --init --network none trufind-backend:test
```

Build the runtime image and bind it to localhost on a free host port such
as 3100. The example sets the container's `PORT` to its default of 3000.
Use `--init` so the container handles shutdown signals and reaps child
processes.

```sh
docker build -t trufind-backend:runtime .
docker run --rm --init --env-file .env.local --env PORT=3000 -p 127.0.0.1:3100:3000 trufind-backend:runtime
curl http://127.0.0.1:3100/health
```

Keep `.env.local` out of Git and use it to supply local runtime settings,
including `AUTH_TOKEN_SECRET`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
`PGPASSWORD`, `AWS_REGION`, `S3_BUCKET`, `GMAIL_USER`, and `GMAIL_PASS`.
Supply secrets and AWS credentials at runtime. Real application use still
requires network access to private RDS and AWS credentials with access to
the S3 bucket. The runtime image includes the public RDS CA bundle for TLS
verification. `/health` reports process availability. It performs no
checks against PostgreSQL, S3, or email.

GitHub Actions runs the isolated tests on the runner and in Docker, builds
the runtime image, and checks its non-root user, native bcrypt dependency,
and `/health` response with fake settings in a network-isolated container.
CI does not deploy. EC2 container deployment requires a separate review
of instance role credential access and CloudWatch logging.
