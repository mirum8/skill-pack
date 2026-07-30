# Bug Patterns — Security

Real-world production bug patterns — things that actually break, not theoretical concerns. Hunter focus: **Security.**

> This is a **fallback checklist** for the `bug-hunter-security` hunter. The primary scan is the real `/security-review` skill; use these patterns only to catch anything the skill didn't surface — not as a replacement for running it.

## Security (Production Impact)

- **SQL injection**: string concatenation in SQL queries instead of parameterized queries
- **Missing auth check**: endpoint/method accessible without authentication or authorization verification
- **Data exposure**: sensitive fields (passwords, tokens, PII) included in API responses, logs, or error messages
- **Path traversal**: user-controlled file path without sanitization — `../../../etc/passwd`
- **Insecure deserialization**: deserializing untrusted data without type filtering
- **Hardcoded credentials**: passwords, API keys, tokens embedded in source code
- **Missing input validation at system boundary**: user input used directly without validation in DB queries, file operations, or external API calls
- **IDOR (Insecure Direct Object Reference)**: accessing resources by ID without verifying the requesting user has permission
