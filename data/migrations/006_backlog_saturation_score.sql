-- Migration 006: Add saturation_score to backlog
ALTER TABLE backlog ADD COLUMN saturation_score REAL DEFAULT 0;
