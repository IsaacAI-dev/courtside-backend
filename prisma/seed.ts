/**
 * Seed (spec §6.7 step 0). Team aliases are seeded exhaustively by hand because
 * there are only 45 teams across both leagues, and doing it once eliminates an
 * entire class of reconciliation bug for the life of the project.
 */
import { PrismaClient } from '@prisma/client';
import { normaliseName } from '../src/lib/normalise';

const prisma = new PrismaClient();

interface TeamSeed {
  name: string;
  shortName: string;
  abbreviation: string;
  city: string;
  conference: string;
  aliases: string[];
}

const WNBA_TEAMS: TeamSeed[] = [
  { name: 'Atlanta Dream', shortName: 'Dream', abbreviation: 'ATL', city: 'Atlanta', conference: 'Eastern', aliases: ['Atlanta', 'ATL Dream'] },
  { name: 'Chicago Sky', shortName: 'Sky', abbreviation: 'CHI', city: 'Chicago', conference: 'Eastern', aliases: ['Chicago', 'CHI Sky'] },
  { name: 'Connecticut Sun', shortName: 'Sun', abbreviation: 'CON', city: 'Uncasville', conference: 'Eastern', aliases: ['Connecticut', 'CONN', 'CT Sun'] },
  { name: 'Dallas Wings', shortName: 'Wings', abbreviation: 'DAL', city: 'Arlington', conference: 'Western', aliases: ['Dallas', 'DAL Wings'] },
  { name: 'Golden State Valkyries', shortName: 'Valkyries', abbreviation: 'GSV', city: 'San Francisco', conference: 'Western', aliases: ['Golden State', 'GS Valkyries', 'Valkyries'] },
  { name: 'Indiana Fever', shortName: 'Fever', abbreviation: 'IND', city: 'Indianapolis', conference: 'Eastern', aliases: ['Indiana', 'IND Fever'] },
  { name: 'Las Vegas Aces', shortName: 'Aces', abbreviation: 'LVA', city: 'Las Vegas', conference: 'Western', aliases: ['Las Vegas', 'LV Aces', 'Vegas Aces', 'LAS'] },
  { name: 'Los Angeles Sparks', shortName: 'Sparks', abbreviation: 'LAS', city: 'Los Angeles', conference: 'Western', aliases: ['Los Angeles Sparks', 'LA Sparks', 'LAS Sparks'] },
  { name: 'Minnesota Lynx', shortName: 'Lynx', abbreviation: 'MIN', city: 'Minneapolis', conference: 'Western', aliases: ['Minnesota', 'MIN Lynx'] },
  { name: 'New York Liberty', shortName: 'Liberty', abbreviation: 'NYL', city: 'Brooklyn', conference: 'Eastern', aliases: ['New York', 'NY Liberty', 'NYL Liberty'] },
  { name: 'Phoenix Mercury', shortName: 'Mercury', abbreviation: 'PHO', city: 'Phoenix', conference: 'Western', aliases: ['Phoenix', 'PHX', 'PHX Mercury'] },
  { name: 'Portland Fire', shortName: 'Fire', abbreviation: 'POR', city: 'Portland', conference: 'Western', aliases: ['Portland', 'POR Fire'] },
  { name: 'Seattle Storm', shortName: 'Storm', abbreviation: 'SEA', city: 'Seattle', conference: 'Western', aliases: ['Seattle', 'SEA Storm'] },
  { name: 'Toronto Tempo', shortName: 'Tempo', abbreviation: 'TOR', city: 'Toronto', conference: 'Eastern', aliases: ['Toronto', 'TOR Tempo'] },
  { name: 'Washington Mystics', shortName: 'Mystics', abbreviation: 'WAS', city: 'Washington', conference: 'Eastern', aliases: ['Washington', 'WSH', 'WAS Mystics'] },
];

const NBA_TEAMS: TeamSeed[] = [
  { name: 'Atlanta Hawks', shortName: 'Hawks', abbreviation: 'ATL', city: 'Atlanta', conference: 'Eastern', aliases: ['Atlanta'] },
  { name: 'Boston Celtics', shortName: 'Celtics', abbreviation: 'BOS', city: 'Boston', conference: 'Eastern', aliases: ['Boston'] },
  { name: 'Brooklyn Nets', shortName: 'Nets', abbreviation: 'BKN', city: 'Brooklyn', conference: 'Eastern', aliases: ['Brooklyn', 'BRK'] },
  { name: 'Charlotte Hornets', shortName: 'Hornets', abbreviation: 'CHA', city: 'Charlotte', conference: 'Eastern', aliases: ['Charlotte', 'CHO'] },
  { name: 'Chicago Bulls', shortName: 'Bulls', abbreviation: 'CHI', city: 'Chicago', conference: 'Eastern', aliases: ['Chicago'] },
  { name: 'Cleveland Cavaliers', shortName: 'Cavaliers', abbreviation: 'CLE', city: 'Cleveland', conference: 'Eastern', aliases: ['Cleveland', 'Cavs'] },
  { name: 'Dallas Mavericks', shortName: 'Mavericks', abbreviation: 'DAL', city: 'Dallas', conference: 'Western', aliases: ['Dallas', 'Mavs'] },
  { name: 'Denver Nuggets', shortName: 'Nuggets', abbreviation: 'DEN', city: 'Denver', conference: 'Western', aliases: ['Denver'] },
  { name: 'Detroit Pistons', shortName: 'Pistons', abbreviation: 'DET', city: 'Detroit', conference: 'Eastern', aliases: ['Detroit'] },
  { name: 'Golden State Warriors', shortName: 'Warriors', abbreviation: 'GSW', city: 'San Francisco', conference: 'Western', aliases: ['Golden State', 'GS Warriors'] },
  { name: 'Houston Rockets', shortName: 'Rockets', abbreviation: 'HOU', city: 'Houston', conference: 'Western', aliases: ['Houston'] },
  { name: 'Indiana Pacers', shortName: 'Pacers', abbreviation: 'IND', city: 'Indianapolis', conference: 'Eastern', aliases: ['Indiana'] },
  { name: 'LA Clippers', shortName: 'Clippers', abbreviation: 'LAC', city: 'Los Angeles', conference: 'Western', aliases: ['Los Angeles Clippers', 'LA Clippers', 'Clippers'] },
  { name: 'Los Angeles Lakers', shortName: 'Lakers', abbreviation: 'LAL', city: 'Los Angeles', conference: 'Western', aliases: ['LA Lakers', 'Lakers'] },
  { name: 'Memphis Grizzlies', shortName: 'Grizzlies', abbreviation: 'MEM', city: 'Memphis', conference: 'Western', aliases: ['Memphis'] },
  { name: 'Miami Heat', shortName: 'Heat', abbreviation: 'MIA', city: 'Miami', conference: 'Eastern', aliases: ['Miami'] },
  { name: 'Milwaukee Bucks', shortName: 'Bucks', abbreviation: 'MIL', city: 'Milwaukee', conference: 'Eastern', aliases: ['Milwaukee'] },
  { name: 'Minnesota Timberwolves', shortName: 'Timberwolves', abbreviation: 'MIN', city: 'Minneapolis', conference: 'Western', aliases: ['Minnesota', 'Wolves'] },
  { name: 'New Orleans Pelicans', shortName: 'Pelicans', abbreviation: 'NOP', city: 'New Orleans', conference: 'Western', aliases: ['New Orleans', 'NO Pelicans'] },
  { name: 'New York Knicks', shortName: 'Knicks', abbreviation: 'NYK', city: 'New York', conference: 'Eastern', aliases: ['New York', 'NY Knicks'] },
  { name: 'Oklahoma City Thunder', shortName: 'Thunder', abbreviation: 'OKC', city: 'Oklahoma City', conference: 'Western', aliases: ['Oklahoma City'] },
  { name: 'Orlando Magic', shortName: 'Magic', abbreviation: 'ORL', city: 'Orlando', conference: 'Eastern', aliases: ['Orlando'] },
  { name: 'Philadelphia 76ers', shortName: '76ers', abbreviation: 'PHI', city: 'Philadelphia', conference: 'Eastern', aliases: ['Philadelphia', 'Sixers', '76ers'] },
  { name: 'Phoenix Suns', shortName: 'Suns', abbreviation: 'PHX', city: 'Phoenix', conference: 'Western', aliases: ['Phoenix', 'PHO'] },
  { name: 'Portland Trail Blazers', shortName: 'Trail Blazers', abbreviation: 'POR', city: 'Portland', conference: 'Western', aliases: ['Portland', 'Blazers'] },
  { name: 'Sacramento Kings', shortName: 'Kings', abbreviation: 'SAC', city: 'Sacramento', conference: 'Western', aliases: ['Sacramento'] },
  { name: 'San Antonio Spurs', shortName: 'Spurs', abbreviation: 'SAS', city: 'San Antonio', conference: 'Western', aliases: ['San Antonio', 'SA Spurs'] },
  { name: 'Toronto Raptors', shortName: 'Raptors', abbreviation: 'TOR', city: 'Toronto', conference: 'Eastern', aliases: ['Toronto'] },
  { name: 'Utah Jazz', shortName: 'Jazz', abbreviation: 'UTA', city: 'Salt Lake City', conference: 'Western', aliases: ['Utah'] },
  { name: 'Washington Wizards', shortName: 'Wizards', abbreviation: 'WAS', city: 'Washington', conference: 'Eastern', aliases: ['Washington', 'WSH'] },
];

async function seedLeague(
  leagueId: string,
  config: {
    displayName: string;
    statsHost: string;
    statsLeagueId: string;
    statsReferer: string;
    seasonFormat: string;
    currentSeason: string;
    espnPathSegment: string;
    betanoPathSegment: string;
  },
  teams: TeamSeed[],
): Promise<void> {
  await prisma.leagueConfig.upsert({
    where: { id: leagueId },
    create: { id: leagueId, ...config },
    update: config,
  });

  for (const team of teams) {
    const row = await prisma.team.upsert({
      where: { leagueId_abbreviation: { leagueId, abbreviation: team.abbreviation } },
      create: {
        leagueId,
        name: team.name,
        shortName: team.shortName,
        abbreviation: team.abbreviation,
        city: team.city,
        conference: team.conference,
      },
      update: { name: team.name, shortName: team.shortName, city: team.city, conference: team.conference },
    });

    // Alias set: full name, short name, abbreviation, city, plus curated variants.
    const aliasSet = new Set([team.name, team.shortName, team.abbreviation, team.city, ...team.aliases]);
    for (const alias of aliasSet) {
      const normalised = normaliseName(alias);
      if (!normalised) continue;
      const existing = await prisma.teamAlias.findFirst({ where: { normalised, source: null } });
      if (existing) continue; // a shared alias like "chicago" can only point one way per league set
      await prisma.teamAlias.create({ data: { teamId: row.id, alias, normalised, source: null } });
    }
  }
}

async function main(): Promise<void> {
  console.log('seeding league configs and teams…');

  // WNBA first: it is the live league today and the primary build target.
  await seedLeague(
    'WNBA',
    {
      displayName: 'WNBA',
      statsHost: 'stats.wnba.com',
      statsLeagueId: '10',
      statsReferer: 'https://www.wnba.com/',
      seasonFormat: 'YYYY',
      currentSeason: '2026',
      espnPathSegment: 'wnba',
      betanoPathSegment: 'basketball/wnba',
    },
    WNBA_TEAMS,
  );

  await seedLeague(
    'NBA',
    {
      displayName: 'NBA',
      statsHost: 'stats.nba.com',
      statsLeagueId: '00',
      statsReferer: 'https://www.nba.com/',
      seasonFormat: 'YYYY-YY',
      currentSeason: '2026-27',
      espnPathSegment: 'nba',
      betanoPathSegment: 'basketball/nba',
    },
    NBA_TEAMS,
  );

  // The 2026 FIBA Women's World Cup break (spec §3.2.1). Without this, every
  // WNBA player returns from the break flagged as "returning from absence"
  // and the entire board is suppressed for a week.
  const breakLabel = "FIBA Women's World Cup 2026";
  const existingBreak = await prisma.leagueBreak.findFirst({ where: { leagueId: 'WNBA', label: breakLabel } });
  if (!existingBreak) {
    await prisma.leagueBreak.create({
      data: {
        leagueId: 'WNBA',
        label: breakLabel,
        startsAt: new Date('2026-09-04T00:00:00.000Z'),
        endsAt: new Date('2026-09-13T23:59:59.000Z'),
        suppressLayoffFlag: true,
      },
    });
  }

  const counts = {
    leagues: await prisma.leagueConfig.count(),
    teams: await prisma.team.count(),
    aliases: await prisma.teamAlias.count(),
    breaks: await prisma.leagueBreak.count(),
  };
  console.log(
    `seeded → ${counts.leagues} leagues · ${counts.teams} teams · ${counts.aliases} team aliases · ${counts.breaks} league break(s)`,
  );
  console.log('\nnext: npm run bootstrap -- --league WNBA   (seeds the player crosswalk from the league feed)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
