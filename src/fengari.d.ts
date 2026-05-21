// fengari (pure-JS Lua 5.3 VM) ships no TypeScript types. Declaring the
// module ambiently keeps the untyped surface confined to a single boundary;
// src/lua.ts immediately narrows it through one explicit structural cast.
declare module "fengari";