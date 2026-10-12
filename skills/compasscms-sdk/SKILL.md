---
name: compasscms-sdk
description: Use when integrating, implementing, reviewing, or debugging JavaScript or TypeScript applications that use the Compass CMS HTTP API through @compasscms/sdk, including setup, posts, custom collections, pagination, API keys, errors, and framework usage.
---

# Compass CMS SDK integration

Help implement integrations with `@compasscms/sdk`, the framework-agnostic
TypeScript client for the versioned Compass CMS HTTP API. The SDK is specific to
the Compass API contract; it is not a generic client for arbitrary CMS APIs.

## Before changing code

1. Identify the app framework, package manager, runtime, and whether the code
   runs on the server or in a browser.
2. Check the installed SDK and contract versions. Read the target app's existing
   API and environment-variable conventions before adding another client
   instance or configuration layer.
3. Consult the versioned [API contract](https://github.com/ramo-dev/compasscms-sdk/blob/main/packages/contracts/API-CONTRACT.md)
   when endpoint behavior, authentication scopes, or payload shapes are unclear.
   Do not invent endpoints or response fields.

## Install and configure

Install both packages because the SDK re-exports types from its contracts peer:

```sh
pnpm add @compasscms/sdk @compasscms/contracts
```

Create a `Compass` client using the CMS API root. The SDK appends `/v1/...`
paths, so do not include `/v1` in `baseUrl` when the server mounts the API below
`/api`.

```ts
import { Compass } from "@compasscms/sdk";

export const compass = new Compass({
  baseUrl: process.env.CMS_API_URL ?? "https://cms.example.com/api",
  apiKey: process.env.CMS_API_KEY,
});
```

Supported options are `baseUrl` (required), `apiKey`, `timeoutMs` (default
15,000), `retries` (default 2), `retryDelayMs` (default 250 ms), and a compatible
`fetch` implementation. Use the app's server environment for secrets.

## Use the client

- Use `compass.posts.list(query)` for one typed page and `compass.posts.all(query)`
  to asynchronously iterate all pages.
- Use `compass.posts.get(idOrSlug, { format })` for an individual post.
- Use `compass.posts.create`, `update`, `delete`, `publish`, and `unpublish` only
  in trusted server-side code with an appropriately scoped key.
- Use `compass.collections` to discover custom collections. Access entries with
  `compass.collection(collectionId)`; custom field values are dynamic, so use
  the published collection schema and contract types rather than assuming a
  fixed content model.
- Authors, categories, and tags are read-only resources.
- The media catalog supports list/get/delete. Uploads use the CMS dashboard's
  authenticated storage flow and are not implemented by this SDK resource.

`list` methods return a page with `items`, `total`, `page`, `pageSize`, and
`pageCount`. `all` methods return async iterators:

```ts
for await (const entry of compass.collection("docs").all()) {
  console.log(entry.title);
}
```

Import API types through `@compasscms/sdk` or directly from
`@compasscms/contracts`:

```ts
import type { Collection, Page, Post } from "@compasscms/sdk";
```

## Authentication and browser safety

- Published reads may work without a key when enabled by the deployment.
- API keys are bearer tokens. Use only the scopes required: `content:read`,
  `content:read:drafts`, `content:write`, and `collections:read`.
- Never expose write-capable keys in browser bundles. A public read-only key may
  be used in a browser if appropriate for the deployment.
- Browser requests require the CMS API to allow the app's CORS origin.

## Errors and retries

Catch `CompassError` or use `isCompassError` to inspect `status`, `code`, and
`details`. Network errors use status `0`. Read requests retry network failures,
HTTP 429, and HTTP 5xx responses using exponential backoff. Mutations are never
retried automatically; do not add blind retries around writes.

## Framework guidance

Use the same client from Next.js server components/route handlers, Astro server
pages, Vue or Svelte server-load functions, and Node.js services. The SDK has no
framework-specific hooks or reactive stores. Keep privileged calls on the
server; browser use should be limited to public reads and read-only keys.

## Verify changes

When editing this SDK repository, run:

```sh
pnpm check
pnpm test
```

When integrating into another app, run that app's typecheck and tests. Verify
that its configured backend implements the endpoints required by the feature;
the SDK package does not deploy or provide the CMS backend.
