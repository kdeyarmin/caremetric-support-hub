import type { HubRepository } from "../domain";
import { config } from "../lib/config";
import { demoRepository } from "./demoRepository";
import { SupabaseSupportRepository } from "./supabaseRepository";

export const repository: HubRepository = config.demoMode
  ? demoRepository
  : new SupabaseSupportRepository();

export { demoRepository };
