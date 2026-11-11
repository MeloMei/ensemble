import { z } from 'zod';
import { PROMPT_SKILL_LIMIT } from '../shared/types';

export const promptSkillListSchema = z.array(z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(200),
}).strict()).max(PROMPT_SKILL_LIMIT);
