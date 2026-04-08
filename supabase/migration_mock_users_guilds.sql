-- ╔═══════════════════════════════════════════════════╗
-- ║  Migration: Add top-10 users to 2 guilds         ║
-- ║  Outplay Elite (6 members) + Phantom (4 members) ║
-- ╚═══════════════════════════════════════════════════╝


-- ═══ 1. Создаём 2 гильдии ═══

-- Outplay Elite (создатель — первый юзер из топа)
INSERT INTO guilds (id, name, description, creator_id, max_members)
VALUES (
  'a0000000-0000-0000-0000-100000000001',
  'Outplay Elite',
  'Лучшие из лучших',
  '309f8ea0-051f-4df5-9312-d77df569d4c9',
  50
) ON CONFLICT DO NOTHING;

-- Phantom (создатель — шестой юзер)
INSERT INTO guilds (id, name, description, creator_id, max_members)
VALUES (
  'a0000000-0000-0000-0000-200000000002',
  'Phantom',
  'Тени побеждают',
  '95bf05ae-f585-449b-9afd-61eea72cf364',
  50
) ON CONFLICT DO NOTHING;


-- ═══ 2. Раскидываем по гильдиям ═══
-- Outplay Elite: 6 человек (топ 1-3 + 7-8 + 10)
-- Phantom: 4 человека (топ 4-6 + 9)

INSERT INTO guild_members (guild_id, user_id, role) VALUES
  -- Outplay Elite
  ('a0000000-0000-0000-0000-100000000001', '309f8ea0-051f-4df5-9312-d77df569d4c9', 'creator'),  -- #1
  ('a0000000-0000-0000-0000-100000000001', '1a0bcc5c-e0fb-49db-9a96-f10c76fffa1a', 'member'),   -- #2
  ('a0000000-0000-0000-0000-100000000001', '39230228-4054-4cec-be1e-0b9511ac2aa5', 'member'),   -- #3
  ('a0000000-0000-0000-0000-100000000001', 'f37260c1-d33e-4c8a-842b-f11ad19f0a64', 'member'),   -- #7
  ('a0000000-0000-0000-0000-100000000001', '3549c886-da69-4a15-b114-105f0bd493fd', 'member'),   -- #8
  ('a0000000-0000-0000-0000-100000000001', 'd056212f-1697-44b3-9405-ce2106a79d18', 'member'),   -- #10

  -- Phantom
  ('a0000000-0000-0000-0000-200000000002', '95bf05ae-f585-449b-9afd-61eea72cf364', 'creator'),  -- #6
  ('a0000000-0000-0000-0000-200000000002', '1c181a0b-b9d6-4780-9aac-7f7b98cf554b', 'member'),   -- #4
  ('a0000000-0000-0000-0000-200000000002', '91596299-24f8-474b-9943-8e6fe8ce0b30', 'member'),   -- #5
  ('a0000000-0000-0000-0000-200000000002', '9891e383-650a-4ddd-bb61-808146560b1c', 'member')    -- #9
ON CONFLICT (guild_id, user_id) DO NOTHING;
