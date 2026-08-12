-- Fix: Drop the old 4-parameter match_chunks overload that conflicts with the new 5-parameter version
DROP FUNCTION IF EXISTS match_chunks(vector, float, int, uuid);
