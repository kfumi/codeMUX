pub const FIND_SKILLS_CONTENT: &str = r#"---
name: find-skills
description: Use when the user needs to find a skill for a specific task, or asks about available skills
---

# Find Skills

Help the user discover and use skills that match their needs.

## Process

1. **Understand the need:** Ask the user what capability they're looking for (if not already clear from context).

2. **Check installed skills:** List all installed skills and identify which ones match the user's need.

3. **Search the marketplace:** If no installed skill matches, browse available skills from configured repositories.

4. **Recommend:** Present the best matching skill(s) with:
   - Name and description
   - How to invoke it (e.g., `/skill-name`)
   - What it does

5. **If nothing fits:** Suggest using `/skill-creator` to create a custom skill for their specific need.

## Guidelines

- Always check installed skills first before searching the marketplace
- Recommend the most specific skill for the task, not the most general one
- If multiple skills could work, present the top 2-3 options with brief comparisons
"#;

pub const SKILL_CREATOR_CONTENT: &str = r#"---
name: skill-creator
description: Use when the user wants to create a new custom skill
---

# Skill Creator

Guide the user through creating a new custom skill.

## Process

1. **Understand the purpose:** Ask what the skill should do and when it should be used.

2. **Choose a name:** Suggest a kebab-case name (e.g., `code-review`, `api-design`). The name becomes the slash command.

3. **Choose a type:**
   - **Technique:** A concrete method with steps to follow
   - **Pattern:** A way of thinking about problems
   - **Reference:** API docs, syntax guides, tool documentation

4. **Write the SKILL.md:**
   - Frontmatter: `name` and `description` (the description determines when Claude auto-invokes the skill)
   - Body: Clear, actionable instructions. Use sections, numbered steps, and examples.

5. **Save and register:**
   - Write the file to `~/.claude/skills/{name}/SKILL.md`
   - The skill is immediately available via `/{name}`

## SKILL.md Template

```markdown
---
name: {name}
description: {one-line description of when to use this skill}
---

# {Title}

## Overview
What this skill does and why.

## Process
Step-by-step instructions.

## Guidelines
Constraints and best practices.
```

## Important

- The `description` field is critical — it determines when Claude automatically invokes the skill
- Keep descriptions specific and action-oriented
- The body should be detailed enough that Claude can follow it without additional context
"#;
