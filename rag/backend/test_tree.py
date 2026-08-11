"""Quick test script to verify tree command output includes UUIDs."""
import asyncio
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.dirname(__file__))

from app.db.supabase import get_supabase_client
from app.services.folder_navigation import execute_tree

async def main():
    supabase = get_supabase_client()

    # Get a real user_id from the database (test@test.com)
    result = supabase.table("user_profiles").select("user_id").limit(1).execute()
    if not result.data:
        print("ERROR: No users found in user_profiles")
        return
    user_id = result.data[0]["user_id"]
    print(f"Using user_id: {user_id}\n")

    # Call tree with same params the agent uses
    output = await execute_tree("root", supabase, user_id, depth=5, limit=200)
    print("=== TREE OUTPUT ===")
    print(output)
    print("=== END ===\n")

    # Verify UUIDs are present
    import re
    uuid_pattern = r'\[[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\]'
    matches = re.findall(uuid_pattern, output)
    if matches:
        print(f"SUCCESS: Found {len(matches)} UUIDs in output")
        for m in matches[:5]:
            print(f"  {m}")
    else:
        print("FAILURE: No UUIDs found in tree output!")

if __name__ == "__main__":
    asyncio.run(main())
