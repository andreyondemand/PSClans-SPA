# Security Policy

## Maintenance status

This project is not actively maintained and has no supported release line or
security-response service-level agreement. Security reports and patches may be
reviewed on a best-effort basis, but users and operators should not assume that
a report will receive a timely response.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository when
it is available. If private reporting is unavailable, open a minimal issue that
asks the owner for a private contact channel. Do not include exploit details,
credentials, personal data, or a working proof of concept in a public issue.

Include the affected URL or file, impact, reproduction prerequisites, and a
suggested mitigation when possible.

## Operational scope

The hosted application has no user accounts or privileged write API. Its public
Worker and browser application depend on Cloudflare, GitHub Pages, BIG Games,
Roblox, RoProxy, and third-party CDN availability. Operators of forks are
responsible for reviewing those dependencies, configuring their own resources,
and monitoring their own deployments.
