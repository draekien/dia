# radio-group

2026-11-01, transformation engine (legacy `new-york`), group on `@base-ui/react/radio-group`, items on `@base-ui/react/radio`.

## Changed

* `src/renderer/src/components/ui/radio-group.tsx`: root → callable `RadioGroupPrimitive`; `RadioGroupItem` → `RadioPrimitive.Root` with `RadioPrimitive.Indicator`; `disabled:*` → `data-disabled:*`.
* `plugins/chat/clarifying-question-card.tsx:140`: ids were `` `${key}-${option.label}` `` where `key` is the question text, so they contained spaces. Base UI names the radio with `aria-labelledby="<id>-label"`, and a space splits that into two missing ids, which left every radio unnamed (6 tests failed on `getByRole('radio', { name: 'Small' })`). Ids are now `` `${useId()}-${questionIndex}-${optionIndex}` ``.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* `onValueChange` receives `(value, eventDetails)`; `value` is typed `any` unless the group is given a type argument.

## Verify by hand

* In a single-select clarifying question, arrow keys move the selection between options.
* A screen reader announces each radio with its option text.
