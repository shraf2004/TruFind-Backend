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

Run the isolated API tests with `node --test` on Node.js 24 after
installing dependencies with `npm ci`.
