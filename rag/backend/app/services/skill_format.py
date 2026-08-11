"""SKILL.md parser/generator for the Agent Skills open standard (agentskills.io)."""
import re

import yaml


class SkillFormatError(Exception):
    """Raised when a SKILL.md file cannot be parsed."""
    pass


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)", re.DOTALL)


def parse_skill_md(content: str) -> dict:
    """Parse a SKILL.md file into a dict of skill fields.

    Expected format:
        ---
        name: my-skill
        description: A short description
        license: MIT
        compatibility: "*"
        metadata:
          key: value
        ---
        # Instructions body (Markdown)
    """
    content = content.strip()
    match = _FRONTMATTER_RE.match(content)
    if not match:
        raise SkillFormatError("SKILL.md must have YAML frontmatter delimited by ---")

    frontmatter_str, body = match.group(1), match.group(2)

    try:
        frontmatter = yaml.safe_load(frontmatter_str)
    except yaml.YAMLError as e:
        raise SkillFormatError(f"Invalid YAML frontmatter: {e}")

    if not isinstance(frontmatter, dict):
        raise SkillFormatError("YAML frontmatter must be a mapping")

    name = frontmatter.get("name")
    if not name or not isinstance(name, str):
        raise SkillFormatError("SKILL.md frontmatter must include a 'name' field")

    description = frontmatter.get("description")
    if not description or not isinstance(description, str):
        raise SkillFormatError("SKILL.md frontmatter must include a 'description' field")

    result = {
        "name": name.strip(),
        "description": description.strip(),
        "instructions": body.strip(),
    }

    # Optional fields
    if "license" in frontmatter and frontmatter["license"] is not None:
        result["license"] = str(frontmatter["license"]).strip()
    if "compatibility" in frontmatter and frontmatter["compatibility"] is not None:
        result["compatibility"] = str(frontmatter["compatibility"]).strip()
    if "metadata" in frontmatter and isinstance(frontmatter["metadata"], dict):
        result["metadata"] = {str(k): str(v) for k, v in frontmatter["metadata"].items()}

    return result


def generate_skill_md(
    name: str,
    description: str,
    instructions: str,
    license: str | None = None,
    compatibility: str | None = None,
    metadata: dict[str, str] | None = None,
) -> str:
    """Generate a SKILL.md file from skill fields."""
    frontmatter: dict = {
        "name": name,
        "description": description,
    }
    if license:
        frontmatter["license"] = license
    if compatibility:
        frontmatter["compatibility"] = compatibility
    if metadata:
        frontmatter["metadata"] = metadata

    yaml_str = yaml.dump(frontmatter, default_flow_style=False, sort_keys=False, allow_unicode=True)
    return f"---\n{yaml_str}---\n{instructions}\n"


# File extension -> standard directory mapping
_SCRIPT_EXTENSIONS = {
    ".py", ".sh", ".bash", ".rb", ".pl", ".lua",
    ".ps1", ".bat", ".cmd",
}
_REFERENCE_EXTENSIONS = {
    ".md", ".txt", ".rst", ".csv", ".json", ".yaml", ".yml",
    ".toml", ".xml", ".html", ".sql", ".log",
}

_SCRIPT_MIMES = {
    "application/x-python", "application/x-sh",
    "application/x-shellscript", "text/x-python", "text/x-script.python",
}
_REFERENCE_MIMES = {
    "application/json", "application/xml", "application/yaml",
    "application/x-yaml", "application/sql", "application/csv",
    "text/plain", "text/markdown", "text/csv", "text/html",
}


def categorize_file(filename: str, mime_type: str) -> str:
    """Categorize a file into 'scripts', 'references', or 'assets'.

    Based on file extension first, then MIME type as fallback.
    """
    ext = ""
    dot_idx = filename.rfind(".")
    if dot_idx >= 0:
        ext = filename[dot_idx:].lower()

    if ext in _SCRIPT_EXTENSIONS:
        return "scripts"
    if ext in _REFERENCE_EXTENSIONS:
        return "references"

    mime_lower = mime_type.lower()
    if mime_lower in _SCRIPT_MIMES:
        return "scripts"
    if mime_lower in _REFERENCE_MIMES or mime_lower.startswith("text/"):
        return "references"

    return "assets"
