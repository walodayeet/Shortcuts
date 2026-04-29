---
name: "shortcuts-create-command"
description: "Create or improve reusable slash shortcuts for the Shortcuts plugin. Use when the user wants to add a shortcut, design argument-capable shortcuts, choose shortcut scope, or turn repeated instructions into reusable commands."
version: "2.0.0"
author: "Aurora"
tags: ["shortcuts", "slash_shortcuts", "commands", "arguments", "scope", "prompt-composition", "templates"]
trigger_patterns:
  - "create shortcut"
  - "add shortcut"
  - "make a shortcut"
  - "make a command"
  - "slash shortcut"
  - "shortcuts command"
  - "shortcut with arguments"
  - "argument shortcut"
  - "use $ARGUMENTS"
  - "use $0"
  - "project shortcut"
  - "agent shortcut"
  - "shortcut template"
---

# Shortcuts Command Creator

Use this skill when the user wants to create, improve, or standardize shortcuts for the `slash_shortcuts` plugin.

Primary plugin:
- `/a0/usr/plugins/slash_shortcuts`

Primary goal:
- create reusable slash shortcuts that expand cleanly in chat
- strongly prefer explicit argument syntax when arguments are needed
- design shortcuts that are reusable, obvious, and scoped correctly

## Core facts you must respect

The plugin supports:
- reusable slash shortcuts
- multiple shortcuts in one message
- scoped shortcuts
- markdown-backed shortcut files with frontmatter
- explicit parenthesized arguments

### Required argument syntax
Use:
- `/command(arguments here)`

Do not prefer:
- `/command arguments here`

Reason:
- this plugin supports multiple shortcuts in one message
- explicit parentheses prevent parsing ambiguity
- argument-capable shortcuts should be designed around `(...)`

## Shortcut file format

Shortcuts are stored as `.shortcut.md` files with YAML frontmatter followed by a markdown body.

### Supported frontmatter keys
- `name`
- `description`
- `display_label`
- `argument_hint`

The markdown body is the instruction template.

## Canonical file skeleton

```md
---
name: tone
description: Rewrite the response in a chosen tone
display_label: Tone
argument_hint: /tone(brutal)
---

Rewrite the response in a $ARGUMENTS tone.
```

## What to decide before drafting a shortcut

When asked to create a shortcut, determine these in order:

1. What repeated task the shortcut should solve
2. Whether it should be reusable or is just a one-off prompt
3. Whether it needs arguments
4. If arguments are needed, whether they are:
   - free-form
   - structured positional
5. Which scope is correct:
   - Global
   - Project
   - Agent
   - Project + Agent
6. What the final expansion should read like in natural language

## Shortcut quality standard

A good shortcut is:
- short
- reusable
- readable in the popup
- predictable
- easy to invoke from memory
- obvious about what goes inside `(...)`
- natural when expanded into a message

A bad shortcut is:
- one-off
- vague
- overloaded with too many positional arguments
- dependent on hidden assumptions
- unreadable after expansion

## Argument design rules

### Rule 1: use no arguments when they add no real value

Do not add arguments just because the plugin supports them.

### Good no-argument shortcut
```md
---
name: review
description: Review the request critically before changing anything
display_label: Review
---

Review the request critically first. Identify flaws, risks, and missing details before proposing changes.
```

Use no arguments when the action is stable and self-contained.

## Rule 2: prefer `$ARGUMENTS` for free-form input

Use `$ARGUMENTS` when the user should be able to pass almost any phrase.

### Best use cases for `$ARGUMENTS`
- tone
- language
- target audience
- focus area
- format
- style
- issue description
- comparison target

### Good examples
- `Rewrite the response in a $ARGUMENTS tone.`
- `Translate this into $ARGUMENTS while preserving meaning and tone.`
- `Focus the answer on $ARGUMENTS.`
- `Find and fix this issue: $ARGUMENTS`

### Example
Shortcut:
- name: `tone`
- argument_hint: `brutal, friendly, professional`
- instruction: `Rewrite the response in a $ARGUMENTS tone.`

Invocation:
- `/tone(brutal)`

Expansion:
- `Rewrite the response in a brutal tone.`

## Rule 3: prefer `$0..$9` for positional structured input

Use positional variables when argument order is meaningful and stable.

### Best use cases for `$0..$9`
- count + audience
- source + target language
- subject + focus
- system + constraint
- metric + time range

### Good examples
- `Summarize this in $0 bullets for a $1 audience.`
- `Translate from $0 to $1.`
- `Explain $0 with emphasis on $1.`
- `Compare $0 against $1 with focus on $2.`

### Example
Shortcut:
- name: `summarize`
- argument_hint: `5 technical`
- instruction: `Summarize this in $0 bullets for a $1 audience.`

Invocation:
- `/summarize(5 technical)`

Expansion:
- `Summarize this in 5 bullets for a technical audience.`

## Rule 4: keep positional argument count low

Prefer:
- 1 to 3 positional slots

Avoid:
- 5+ positional slots unless the structure is extremely obvious

If a shortcut needs too many moving parts:
- redesign it
- split it into multiple shortcuts
- replace rigid positional structure with `$ARGUMENTS`

## Rule 5: write argument hints that teach usage instantly

The `argument_hint` should show what belongs inside the parentheses.

### Weak hints
- `text`
- `anything`
- `input`
- `arg`

### Good hints
- `brutal, friendly, professional`
- `5 technical`
- `English Vietnamese`
- `beginner security`
- `competitor pricing UX`
- `bug summary`

### Hint writing rule
A user should understand the shortcut from the popup without opening the file.

## Rule 6: expansion must read naturally

After substitution, the instruction should sound like something a human would actually write.

### Bad
- `Do $ARGUMENTS in a good way with improvements.`

### Better
- `Improve the response with emphasis on $ARGUMENTS.`

### Bad positional design
- `Use $0 for $1 with $2 and $3.`

### Better
- `Explain $0 for a $1 audience with emphasis on $2.`

## Scope selection rules

The plugin supports these scopes:
- Global
- Project
- Agent
- Project + Agent

Choose the narrowest scope that still makes sense.

### Use Global when
The shortcut is broadly useful across most chats.

Examples:
- `fix`
- `review`
- `summarize`
- `tone`
- `translate`
- `explain`

### Use Project when
The shortcut is tied to a project domain, repository, workflow, or vocabulary.

Examples:
- `restaurant-schema`
- `server-audit`
- `auth-architecture`
- `obsidian-cleanup`

### Use Agent when
The shortcut encodes a profile-specific working style.

Examples:
- coding-agent review shortcut
- mail-triage classification shortcut
- note-synthesis formatting shortcut

### Use Project + Agent when
The shortcut only makes sense for one agent role inside one project.

Examples:
- project-specific code review shortcut for the developer profile
- project-specific status-summary shortcut for the note synthesizer profile

### Scope anti-pattern
Do not over-scope a shortcut just because you can.
If Global or Project is enough, use that.

## Design workflow

When the user asks for a shortcut, follow this process.

### Step 1: define the repeated job
Ask or infer:
- what repeated behavior should this shortcut trigger?
- what should the expanded text tell the agent to do?

### Step 2: decide whether arguments are needed
Choose one:
- no arguments
- `$ARGUMENTS`
- positional `$0..$9`

### Step 3: choose scope
Choose one:
- Global
- Project
- Agent
- Project + Agent

### Step 4: draft the shortcut fields
Draft:
- `name`
- `display_label`
- `description`
- `argument_hint`
- instruction body

### Step 5: simulate real use
Mentally test:
- how it appears in popup
- how it looks when typed
- how the expansion reads in a real message

### Step 6: only then write the file
Use the actual `.shortcut.md` structure.

## Shortcut proposal output format

When proposing a shortcut, present it in this exact structure.

Name:
- `tone`

Display label:
- `Tone`

Description:
- `Rewrite the response in a chosen tone.`

Argument hint:
- `brutal, friendly, professional`

Scope:
- `Global`

Instruction:
- `Rewrite the response in a $ARGUMENTS tone.`

Suggested filename:
- `tone.shortcut.md`

## File content output format

When the user wants the actual shortcut file, output the file contents directly.

```md
---
name: tone
description: Rewrite the response in a chosen tone
display_label: Tone
argument_hint: /tone(brutal)
---

Rewrite the response in a $ARGUMENTS tone.
```

## Heuristics for picking the right argument model

Use this decision rule:

### Choose no arguments if
- the command always means the same thing
- the user never needs to vary input

### Choose `$ARGUMENTS` if
- the user may pass a phrase, sentence, or variable natural-language target
- argument order does not matter
- flexibility matters more than rigid structure

### Choose `$0..$9` if
- order matters
- each position has a clear meaning
- the shortcut benefits from compact structured usage

## Examples by category

### Tone shortcut
```md
---
name: tone
description: Rewrite the response in a chosen tone
display_label: Tone
argument_hint: /tone(brutal)
---

Rewrite the response in a $ARGUMENTS tone.
```

### Translate shortcut
```md
---
name: translate
description: Translate the content into a target language
display_label: Translate
argument_hint: /translate(Spanish)
---

Translate the content into $ARGUMENTS while preserving the original meaning and tone.
```

### Fix shortcut
```md
---
name: fix
description: Fix a specific issue using the provided argument
display_label: Fix
argument_hint: /fix(describe the issue)
---

Find and fix this issue: $ARGUMENTS
```

### Structured summarize shortcut
```md
---
name: summarize
description: Summarize for a specific audience and length
display_label: Summarize
argument_hint: /summarize(5 technical)
---

Summarize this in $0 bullets for a $1 audience.
```

### Compare shortcut
```md
---
name: compare
description: Compare two things with an optional focus
display_label: Compare
argument_hint: /compare(optionA optionB pricing)
---

Compare $0 against $1 with emphasis on $2.
```

## Review checklist before finalizing a shortcut

- [ ] Name is short, lowercase, and memorable
- [ ] Description is useful in the popup
- [ ] Display label is clean for UI
- [ ] Scope is justified
- [ ] Argument strategy is intentional
- [ ] `argument_hint` teaches usage clearly
- [ ] Instruction is reusable
- [ ] Expansion reads naturally
- [ ] The command is not a one-off task disguised as a shortcut
- [ ] Parenthesized invocation syntax is respected

## When asked to implement the shortcut, not just design it

If the user wants the shortcut created in files:
1. determine the correct scope path
2. write a `.shortcut.md` file
3. use the exact frontmatter/body structure
4. if relevant, mention the full path used

## Known plugin paths and references

Examples live at:
- `/a0/usr/plugins/slash_shortcuts/helpers/examples/`

Global editable shortcuts commonly live at:
- `/a0/usr/plugins/slash_shortcuts/shortcuts/`

Project-scoped shortcuts commonly live under:
- `project/.a0proj/plugins/slash_shortcuts/shortcuts/`

## Final rule
Do not create bloated shortcuts. A shortcut should compress repeated intent, not encode an entire application protocol.
