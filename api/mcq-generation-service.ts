import { SpaceforgeSettings } from '../models/settings';
import { MCQSet } from '../models/mcq';
import SpaceforgePlugin from '../main';

export interface IMCQGenerationService {
    plugin: SpaceforgePlugin; // To allow implementations to access plugin features like settings, notices
    generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null>;
}
