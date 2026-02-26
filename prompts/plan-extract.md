# Plan Extract Template

Use this template when normalizing plan output for extraction into revision items.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Extract-Specific Requirements

- Ensure each item has `id`, `title`, and non-empty `prompt`.
- Preserve dependency ids exactly.
- Reject unknown or cyclic dependencies.
- Surface parser-facing errors clearly in rationale and payload.

## Output

- Natural-language rationale
- Structured payload per prompt contract
- Normalized YAML ready for extraction persistence
