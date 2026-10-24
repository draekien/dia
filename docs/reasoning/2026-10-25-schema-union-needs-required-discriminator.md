# An effect `Schema.Union` reports one member's errors only when the discriminator is required

**Date:** 2026-10-25

## Context

`PluginManifest` became a union of `FeatureManifest` and `AdapterManifest`, discriminated on `category` (`docs/designs/adapter-category.md`). The first draft kept `category` optional on the feature member, so existing `plugin.json` files without it would still decode as features. The adapter member forbids `renderer`, `inject` and `load`, and requires `host`, each with its own message, so that a developer sees every problem in an invalid adapter manifest at once.

## Reasoning / Learning

effect v4 picks the union members to try from "sentinels": property signatures whose type is a literal and that are **not optional** (`collectSentinels` and `getCandidateIndex` in `node_modules/effect/src/SchemaAST.ts`). A member with no sentinel is tried for every object input.

With `category: Schema.optionalKey(Schema.Literal('feature'))` on the feature member, an adapter manifest with no `host` that declares `renderer` and `inject` decoded to:

```
SchemaError(Expected "feature"
  at ["category"]
Missing key
  at ["host"])
```

The feature member's mismatch came first, the `messageMissingKey` annotation was not used, and the `renderer` and `inject` messages were missing. With `category` required on both members, and the decode run with `{ errors: 'all' }`, the same manifest decoded to:

```
SchemaError(an adapter needs a "host" entry, because it runs in the Host
  at ["host"]
an adapter has no UI, so it cannot declare "renderer"
  at ["renderer"]
an adapter cannot declare "inject": a reload of the plugin it injects from would close the adapter
  at ["inject"])
```

A manifest with no `category`, or an unknown one, matches no candidate. Its failure is the union's own `message` annotation: `plugin.json must declare "category" as "feature" or "adapter"`.

Other findings from the same prototype:

- `Schema.optionalKey(Schema.Never.annotate({ message }))` forbids a key and reports `message` when the key is present. The property type stays `never | undefined`, so code can still read `manifest.inject` on the union without narrowing.
- `Schema.String.pipe(Schema.annotateKey({ messageMissingKey }))` sets the message for a required key that is absent.
- Without `{ errors: 'all' }`, decoding stops at the first problem.

## Implication

Give every member of a discriminated union a required literal key, even when that breaks a default such as "absent means feature". Decode user-written files with `{ errors: 'all' }` so every problem is reported. `category` is therefore required in every `plugin.json`, and an override folder written before this change fails to load until it declares one.
