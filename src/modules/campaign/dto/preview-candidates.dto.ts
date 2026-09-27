import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CANDIDATE_ROLES } from '../../google-sheet';
import { TEMPLATE_TYPES } from '../../template';
import type { TemplateType } from '../../template';

export class PreviewCandidatesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 5;

  @IsOptional()
  @IsIn(CANDIDATE_ROLES)
  role?: string;

  @IsOptional()
  @IsIn(Object.values(TEMPLATE_TYPES))
  type: TemplateType = TEMPLATE_TYPES.INITIAL;
}
