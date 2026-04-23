DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE duels;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;
