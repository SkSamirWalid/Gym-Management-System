# Gym Management System

A full‑stack Node.js + Express + EJS app for managing gym memberships, attendance, health metrics, notifications, and admin reporting — backed by MySQL (XAMPP friendly) and optional email via SMTP. ngrok can expose your local app publicly for features like email verification links.

## Tech Stack
- Node.js (>=18), Express 5, EJS
- MySQL/MariaDB (via XAMPP or standalone)
- express-session + express-mysql-session (sessions in MySQL)
- bcrypt, express-validator
- node-cron (scheduled tasks)
- nodemailer (SMTP email)
- ngrok (optional, for public URL)

## Features
- Authentication with email verification and session management
- Membership plans and auto-activation/expiration
- Attendance check-in/out and weekly consistency tracking
- Health metrics (BMI auto-calculated) + tailored tips
- Notifications (UI + optional email)
- Admin dashboard with KPIs + drilldowns
- CSV export for attendance
- Scheduled reminders (renewal, low attendance)
- Auto-injects /public/js/main.js into every rendered view

## Project Structure
- app.js — Express app, routes, cron jobs, email, guards
- db.js — MySQL pool (mysql2/promise)
- views/ — EJS templates (e.g., login.ejs, register.ejs, dashboard.ejs, profiles.ejs, plans.ejs, attendance.ejs, health.ejs, tips.ejs, notifications.ejs, admin_* views, and partials/)
- public/
  - js/main.js
  - css/
- schema.sql — clean DB schema (no data)
- .env.example — environment template
- package.json

## Prerequisites
- Node.js 18+
- MySQL/MariaDB (XAMPP MySQL works great)
- Optional: ngrok for public URL (email verification links)
- Optional: SMTP credentials (Gmail or other)

## Quick Start (Local)

1) Install prerequisites
- Install Node.js 18+.
- Install XAMPP (or MySQL/MariaDB). Ensure phpMyAdmin is accessible.

2) Configure environment
- Copy .env.example to .env and set values.

3) Ensure MySQL is running (XAMPP)
- Start MySQL service in XAMPP.

4) Create the database schema
- Open phpMyAdmin → select your server → import schema.sql.

5) Install dependencies
- npm install

6) Start the server
- npm run dev
- npm start
- Visit http://127.0.0.1:3000

7) Optional: expose locally via ngrok
- ngrok http 3000
- Copy the https URL from ngrok and set BASE_URL in your .env so email links resolve publicly.

## Default Admin
On first run, if no admin exists, the app seeds:
Email: admin@gym.com
Password: admin123

- Change this immediately in production.

## Scheduled Tasks
- An hourly cron runs activate/expire and daily reminder logic (“0 * * * *”).
- Daily reminders trigger once per day after DAILY_RUN_HOUR.
- You can force-run via GET /admin/run-daily (admin only).

## CSV Export
- Admin-only: /admin/export/attendance.csv?from=YYYY-MM-DD&to=YYYY-MM-DD

## Views referenced by code
Make sure these templates exist (exact names):

- auth: register.ejs, login.ejs, verify_result.ejs, resend_verification.ejs

- member: dashboard.ejs, profiles.ejs, plans.ejs, attendance.ejs, health.ejs, tips.ejs, notifications.ejs

- admin: admin_dashboard.ejs, admin_memberships_active.ejs, admin_memberships_expiring.ejs, admin_checkins_today.ejs, admin_plans_list.ejs, admins_plans_form.ejs, admin_users.ejs

- shared: views/partials/*

Note: The plans form is rendered as “admins_plans_form” in code.

## Security Notes
- Use a strong SESSION_SECRET.
- Keep EMAIL_ENABLED=false in local dev if you don’t want to send emails.
- Don’t commit your .env (already ignored in .gitignore).
- If deploying behind HTTPS, consider secure cookies in session config.

## Troubleshooting
- ER_ACCESS_DENIED: Check DB_USER/DB_PASSWORD in .env.
- ECONNREFUSED 127.0.0.1:3306: Start MySQL in XAMPP.
- Unknown database 'gymdb': Import schema.sql via phpMyAdmin or MySQL CLI.
- Gmail SMTP failures: Use an App Password (with 2FA) and SMTP_SECURE=true/SMTP_PORT=465.