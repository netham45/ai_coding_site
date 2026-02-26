# Plan Approve Template

Use this template for approval/materialization decisions before creating child tasks or sub-plans.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Approval-Specific Requirements

- Confirm dependency topology is valid for parent/merge targets.
- Confirm recursion depth stays within configured limits.
- Produce explicit auto-merge and auto-start guidance per child node.
- Include idempotency keys to prevent duplicate approvals.

## Output

- Natural-language rationale
- Structured payload per prompt contract
- Approval decision summary for task creation
