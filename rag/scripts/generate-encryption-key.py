#!/usr/bin/env python3
"""Generate a Fernet encryption key for SETTINGS_ENCRYPTION_KEY."""

from cryptography.fernet import Fernet

key = Fernet.generate_key().decode()

print("=" * 60)
print("Generated encryption key for settings:")
print("=" * 60)
print()
print(key)
print()
print("=" * 60)
print("Add this to your backend/.env file:")
print("=" * 60)
print()
print(f"SETTINGS_ENCRYPTION_KEY={key}")
print()
