# Claude Code Guide

Read `AGENTS.md` first; it is the canonical repository guide.

## Bounded File Reads

When a file is subject to a size limit, use `lstat`/`stat` and reject it before `readFile` if its reported size is already too large. Retain a post-read byte check for races and encoding differences. A limit checked only after reading the full file does not protect memory.
