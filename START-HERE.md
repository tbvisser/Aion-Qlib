# AION — Full Stack AI Agent Platform

A reference implementation and foundation for building AI agent systems with AI coding tools.

This project was built collaboratively with Claude Code across multiple development episodes. Each episode adds new capabilities — from basic RAG to knowledge base exploration, PII redaction, and code execution sandboxes.

You can use this content in different ways depending on your goals.

---

## The App

The Agentic RAG App is a full-stack AI application with a chat interface, document ingestion, and a complete RAG pipeline. Users can upload documents (PDF, DOCX, Markdown, etc.), which are chunked, embedded, and stored in a vector database. The chat interface uses hybrid search and reranking to retrieve relevant context, and supports agentic features like text-to-SQL, web search, sub-agents, and a Knowledge Base Explorer with filesystem-like tools. Advanced features include PII redaction (with Microsoft Presidio), a Skills system for reusable AI behaviors, and a code sandbox for executing Python in isolated Docker containers.

---

## Choose Your Path

### Path 1: Use the App

**Best for:** People who want a working AI agent platform without heavy customization.

You'll clone the repo, spin it up, and use it as-is. You can make minor changes (branding, logo, config) and stay in sync with upstream releases.

> **Note:** This is a learning project, not a hardened production application. It's actively developed and not every feature has been fully tested across all edge cases. Think of it as beta software — functional and useful, but expect rough edges. It will become more stable over time as development continues.

**Get started:**
1. Clone the repo: `git clone https://github.com/tbvisser/Aion-RAG.git`
2. Follow the [README](./README.md) to set up and run the app
3. Pull new releases as they come out

---

### Path 2: Fork and Extend

**Best for:** People who want to start from a specific episode and add their own features.

You'll fork from a release tag, push to your own repo, and build on top. You can occasionally merge upstream changes if you haven't diverged too much.

**Get started:**
1. Clone from a specific release tag:
   ```bash
   git clone --branch ep3 --single-branch https://github.com/tbvisser/Aion-RAG.git my-project
   cd my-project
   git checkout -b main
   ```
2. Push to your own GitHub repo
3. Follow the [README](./README.md) to set up and run the app
4. Build your own features with Claude Code or Cursor

**Available release tags:**

Each episode is tagged as a release. For example:
- `ep2` — Knowledge Base Explorer
- `ep3` — PII Redaction System

See the full list on the [Releases page](https://github.com/tbvisser/Aion-RAG/releases).

---

### Path 3: Fork and Build Your Own

**Best for:** People who want to take the foundation and go in their own direction.

You'll fork from a release, then use Claude Code to heavily customize and extend. Since you're using AI tools to make sweeping changes, your codebase will diverge significantly from upstream.

**Get started:**
1. Clone from a release tag (same as Path 2)
2. Push to your own GitHub repo
3. Follow the [README](./README.md) to set up and run the app
4. Build freely — this is now your codebase

**Adding features from future episodes:**

Don't try to merge upstream — it'll be a mess. Instead, use the in-repo planning docs:

👉 **[`.agent/plans/reference/`](./.agent/plans/reference/)**

Each file contains the PRD used to build that episode. Read the PRD, adapt it to your codebase, and feed it to Claude Code to implement.

---

### Path 4: Build from Scratch

**Best for:** People who want the deepest learning experience.

You won't use this repo's code at all. Instead, you'll use the planning docs and build everything yourself from scratch with Claude Code.

**Get started:**
1. Read the planning docs in [`.agent/plans/reference/`](./.agent/plans/reference/)
2. Start a fresh project and let Claude Code build it based on the PRDs

This is the purest "learn by doing" path. You're not starting with any scaffold — you're building the entire system yourself.

---

## Staying in Sync with Upstream

**If you're on Path 1 or early Path 2** (minimal changes), you can pull upstream releases:

```bash
# If you kept the remote as "upstream"
git fetch upstream
git merge ep5
```

**If you're on Path 3** (heavy customization with AI tools), don't try to merge. Codebases built independently with AI diverge fast — different variable names, schemas, structures. Merging will create hundreds of conflicts. Use the planning docs approach instead.

---

## Deployment

You can run this app locally or deploy it to the cloud:

- **Local:** Docker + self-hosted Supabase + local LLMs (Ollama/LM Studio)
- **Cloud:** Vercel (or any hosting) + Supabase Cloud + OpenAI/OpenRouter

See the [README](./README.md) for detailed setup and deployment instructions.

---

## Resources

- [README](./README.md) — Setup and running the app
- [CLAUDE.md](./CLAUDE.md) — Context for Claude Code
- [`.agent/plans/reference/`](./.agent/plans/reference/) — PRDs for each episode
- [AION Partners](https://aionpartners.eu) — About
