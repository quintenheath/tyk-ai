# TYK

TYK is a knowledge-first assistant for commercial door companies. It searches
deterministic facts, learned answers, documents, connected sources, and saved
external research before using general AI reasoning.

## Web Research

On-demand public-web research uses Gemini's current Google Search grounding
tool (`google_search`). It runs only when internal retrieval has no reliable
match. Grounding citations are stored in the separate `web_sources` table with
their URL, title, domain, retrieval date, snippet, topic, entity relationship,
answer, confidence, and source type. External sources are never automatically
promoted to company-confirmed knowledge.

Configure the server-side Supabase secret before expecting live web answers:

```sh
supabase secrets set GEMINI_API_KEY=your_key
supabase secrets set GEMINI_SEARCH_MODEL=gemini-2.5-flash
```

The key is never exposed to the browser or committed to this repository.

## Conversation Metadata

Persistent conversations use the existing `conversations` table as their
source of truth. The `title` and `topic_summary` fields are updated through
the existing conversation store when a grounded research result provides a
more specific topic. The longer `summary` field remains the rolling context
for older turns and is generated only in batches.

## Development

Run `npm install`, then `npm run dev`. Use `npm run lint` and `npm run build`
before deployment.

---

The remaining sections below are the original Vite template notes.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
