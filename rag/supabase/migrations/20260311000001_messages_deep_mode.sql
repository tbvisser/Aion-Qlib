-- Story 1.1: Add deep_mode column to messages table

ALTER TABLE messages ADD COLUMN deep_mode BOOLEAN NOT NULL DEFAULT false;
