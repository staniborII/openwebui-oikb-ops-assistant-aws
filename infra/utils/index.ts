// Adds the stage to a resource name, and says whether that stage keeps its data on delete.
import { Stage } from '../types';

export function stagified(resourceName: string, stage: Stage, toTitleCase = true): string {
  if (toTitleCase) {
    return `${resourceName}${stage.charAt(0).toUpperCase() + stage.slice(1)}`;
  }
  return `${resourceName}-${stage.toLowerCase()}`;
}

export function removalPolicy(stage: Stage): 'destroy' | 'retain' {
  return stage === 'prod' ? 'retain' : 'destroy';
}
