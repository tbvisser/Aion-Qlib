#!/usr/bin/env python3
"""Sync global skill definitions from YAML files into the database.

Reads all .yaml files from backend/skills/ and upserts them as global skills
(user_id=NULL) in the skills table, matching on the skill name.

Usage:
    cd backend
    python -m scripts.sync_skills          # from backend dir
    python scripts/sync_skills.py          # standalone
"""

import sys
from pathlib import Path

# Allow running both as `python -m scripts.sync_skills` and `python scripts/sync_skills.py`
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

import yaml
from dotenv import load_dotenv

load_dotenv(backend_dir / ".env")

from supabase import create_client
from app.config import get_settings

SKILLS_DIR = backend_dir / "skills"


def load_skill_files() -> list[dict]:
    """Load all .yaml skill definitions from the skills directory."""
    skills = []
    for path in sorted(SKILLS_DIR.glob("*.yaml")):
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        # Validate required fields
        for field in ("name", "description", "instructions"):
            if not data.get(field):
                print(f"  SKIP {path.name}: missing required field '{field}'")
                continue
        data["_source"] = path.name
        skills.append(data)
    return skills


def sync_skills():
    """Upsert global skill definitions into the database."""
    settings = get_settings()
    supabase = create_client(settings.supabase_url, settings.supabase_service_role_key)

    skill_files = load_skill_files()
    if not skill_files:
        print("No skill files found in", SKILLS_DIR)
        return

    print(f"Found {len(skill_files)} skill file(s) in {SKILLS_DIR}\n")

    for skill_data in skill_files:
        source = skill_data.pop("_source")
        name = skill_data["name"]

        # Check if a global skill with this name already exists
        existing = (
            supabase.table("skills")
            .select("id, name, description, instructions")
            .eq("name", name)
            .is_("user_id", "null")
            .maybe_single()
            .execute()
        )

        if existing and existing.data:
            # Check if anything actually changed
            changed = False
            for field in ("description", "instructions"):
                if existing.data.get(field) != skill_data.get(field):
                    changed = True
                    break

            if not changed:
                print(f"  SKIP {source}: '{name}' is already up to date")
                continue

            # Update existing global skill
            supabase.table("skills").update({
                "description": skill_data["description"],
                "instructions": skill_data["instructions"],
            }).eq("id", existing.data["id"]).execute()
            print(f"  UPDATE {source}: '{name}' updated")
        else:
            # Insert new global skill
            supabase.table("skills").insert({
                "user_id": None,
                "name": name,
                "description": skill_data["description"],
                "instructions": skill_data["instructions"],
            }).execute()
            print(f"  INSERT {source}: '{name}' created")

    print("\nDone.")


if __name__ == "__main__":
    sync_skills()
