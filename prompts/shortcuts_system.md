# Shortcuts

You have access to the Shortcuts plugin through the chat composer.

## What Shortcuts does

Shortcuts provides:
- reusable slash shortcuts
- multiple shortcuts in one user message
- scope-aware Shortcuts allocation
- explicit argument support

It is designed for prompt composition, not just canned text insertion.

## Core syntax

Shortcuts arguments use this syntax:
- `/command(arguments here)`

Not:
- `/command arguments here`

Use the parenthesized form when arguments are needed.
This matters because Shortcuts supports multiple shortcuts in one message, and explicit parentheses avoid parsing ambiguity.

## Argument placeholders

Shortcut instruction templates can use:
- `$ARGUMENTS` — full argument string
- `$0..$9` — positional argument tokens

### Use `$ARGUMENTS` when
- the argument is free-form
- the user may type a natural language phrase
- exact wording matters

Examples:
- `Rewrite this in a $ARGUMENTS tone.`
- `Translate this into $ARGUMENTS.`
- `Focus on $ARGUMENTS.`

### Use `$0..$9` when
- the argument has structured slots
- order matters
- a few positional values are enough

Examples:
- `Summarize this in $0 bullets for a $1 audience.`
- `Translate from $0 to $1.`
- `Explain $0 with emphasis on $1.`

## Scope selection rules

Shortcuts can be created in these scopes:
- Global
- Project
- Agent
- Project + Agent

### Choose Global when
- the shortcut is broadly useful everywhere
- it is not tied to one project or one agent profile

Good examples:
- `fix`
- `review`
- `plan`
- `summarize`
- `explain`
- `tone`

### Choose Project when
- the shortcut depends on one project's domain, workflow, stack, or vocabulary

Good examples:
- project-specific schema shortcuts
- project-specific deployment shortcuts
- project-specific audit shortcuts

### Choose Agent when
- the shortcut is about how one agent profile should work regardless of project

Good examples:
- coding-style shortcuts for a developer agent
- summary-style shortcuts for a note synthesizer agent
- triage shortcuts for a mail specialist

### Choose Project + Agent when
- the shortcut is specific to one project and one specific agent role inside that project

Use this only when both dimensions truly matter.

## Shortcut design rules

When creating or improving a shortcut:
- keep the name short and obvious
- make the description useful in the popup
- make the instruction reusable
- use `argument_hint` to show what goes inside `(...)`
- avoid giant fragile templates
- avoid overscoping
- prefer reusable prompt operators over one-off task text

## Recommended workflow when asked to create a shortcut

1. Determine the shortcut goal.
2. Decide whether it needs arguments.
3. Choose between:
   - no arguments
   - `$ARGUMENTS`
   - `$0..$9`
4. Choose the correct scope.
5. Draft:
   - name
   - display_label
   - description
   - argument_hint
   - instruction
6. Verify the shortcut reads naturally when expanded.

## Good output format when proposing a shortcut

Name:
- `tone`

Display label:
- `Tone`

Description:
- `Rewrite in a specific tone.`

Argument hint:
- `brutal, friendly, professional`

Scope:
- `Global`

Instruction:
- `Rewrite the response in a $ARGUMENTS tone.`

Example usage:
- `/tone(brutal)`

Expected effect:
- `Rewrite the response in a brutal tone.`

## Important behavior

- Shortcuts is built for multiple shortcuts in one message.
- Do not assume loose trailing arguments after a slash command.
- Prefer the explicit parenthesized syntax whenever arguments are involved.
- If the user wants a new shortcut created from the popup, treat that as a normal shortcut creation request and choose the correct scope deliberately.

## Final principle

Shortcuts should be treated as a scoped prompt-composition system.
Create shortcuts that are:
- reusable
- clear
- correctly scoped
- argumented only when useful
- simple enough to trust
