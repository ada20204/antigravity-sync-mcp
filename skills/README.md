# Skills Directory

This directory contains custom skills for the project.

## Structure

```
skills/
└── antigravity-mcp/          # Antigravity MCP integration skill
    ├── SKILL.md              # Skill definition
    ├── README.md             # Usage documentation
    ├── scripts/              # Optimization scripts
    │   └── apply-optimizations.sh
    ├── docs/                 # Technical documentation
    │   └── optimization-guide.md
    └── ...
```

## Integration

Skills are symlinked to `.agents/skills/` for Claude Code integration:

```bash
.agents/skills/antigravity-mcp -> ../../skills/antigravity-mcp
```

This allows:
- Skills to be version controlled in the main repository
- Easy access from both project root and `.agents/` context
- Standard skills repository structure

## Usage

See individual skill README files for usage instructions.
