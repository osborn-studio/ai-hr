import{createMigratingPrivateCommandJournal}from'./private-commands.mjs';
// Shared metadata-only journal, including legacy original-ID migration and
// status reconciliation. Scores, comments and monetary bodies stay in memory.
export const createPerformanceCommandJournal=options=>createMigratingPrivateCommandJournal({...options,namespace:'performance',legacyPrefix:'performance.'});
