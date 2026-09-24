// The single Supabase client instance for the whole app. Uses only the
// public anon key (protected by RLS) -- never a service-role key.
// window.supabase is provided by the supabase-js UMD <script> in index.html.

export var SUPABASE_URL = "https://srbiynpchtwtpzcyrhgr.supabase.co";
export var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyYml5bnBjaHR3dHB6Y3lyaGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMzI4MzAsImV4cCI6MjEwNDkwODgzMH0.8RLhotRZn8OXH4BPVIgw1d-mATA5rxW2aA_-p4_JoRg";
export var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
