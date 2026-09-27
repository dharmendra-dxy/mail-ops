import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PreviewCandidatesDto } from './preview-candidates.dto';

const TRUTHY = ['true', '1', 'yes'];
const FALSY = ['false', '0', 'no'];

export class SendCampaignDto extends PreviewCandidatesDto {
  /**
   * A send defaults to a full PRD-sized batch, while preview stays small so its
   * response remains readable. Whichever it is, `eligible` in the response shows
   * when more rows matched than were processed.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 50;

  /**
   * Left undefined when omitted so the service can fall back to
   * SEND_DEFAULT_DRY_RUN (itself defaulting to true): a real send is never the
   * accidental outcome of a request that forgot the parameter.
   *
   * Unrecognised values are passed through untouched so `@IsBoolean()` rejects
   * them — a typo like `?dryRun=maybe` must fail loudly rather than resolve to
   * false and mail the whole batch.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;

    const normalized = String(value).toLowerCase();
    if (TRUTHY.includes(normalized)) return true;
    if (FALSY.includes(normalized)) return false;

    return value as unknown;
  })
  @IsBoolean()
  dryRun?: boolean;
}
