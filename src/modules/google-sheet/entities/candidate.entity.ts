import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  BOOLEAN_FLAGS,
  CANDIDATE_ROLES,
  CANDIDATE_STATUSES,
  FOLLOW_UP_STATUSES,
  MAX_FOLLOW_UP_DAYS,
} from '../google-sheet.constant';

/**
 * A single sheet row. Field values are kept as raw strings (and numbers for
 * counters) because a malformed row must survive the read so `/campaign/validate`
 * can report exactly which cell is wrong instead of silently dropping it.
 * The class-validator decorators below are the single source of truth for the
 * sheet's data contract.
 */
export class Candidate {
  @IsInt()
  @Min(1)
  rowNumber: number;

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'email is required' })
  @IsEmail({}, { message: 'email is not a valid email address' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'company is required' })
  company: string;

  @IsString()
  @IsNotEmpty({ message: 'role is required' })
  @IsIn(CANDIDATE_ROLES, {
    message: `role must be one of: ${CANDIDATE_ROLES.join(', ')}`,
  })
  role: string;

  @IsIn(CANDIDATE_STATUSES, {
    message: `status must be one of: ${CANDIDATE_STATUSES.join(', ')}`,
  })
  status: string;

  @IsOptional()
  @IsString()
  sentAt: string | null;

  @IsOptional()
  @IsString()
  messageId: string | null;

  @IsOptional()
  @IsString()
  error: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  attempts: number;

  @IsOptional()
  @IsString()
  campaignId: string | null;

  @IsIn(BOOLEAN_FLAGS, {
    message: `follow_up_enabled must be one of: ${BOOLEAN_FLAGS.join(', ')}`,
  })
  followUpEnabled: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_FOLLOW_UP_DAYS)
  followUpDays: number;

  @IsIn(FOLLOW_UP_STATUSES, {
    message: `follow_up_status must be one of: ${FOLLOW_UP_STATUSES.join(', ')}`,
  })
  followUpStatus: string;

  @IsOptional()
  @IsString()
  followUpSentAt: string | null;

  @IsOptional()
  @IsString()
  followUpMessageId: string | null;

  @IsOptional()
  @IsString()
  processingStartedAt: string | null;
}
