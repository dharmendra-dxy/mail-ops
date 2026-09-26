import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectSheetDto {
  @IsString()
  @IsNotEmpty({ message: 'spreadsheetUrl is required' })
  @MaxLength(500, { message: 'spreadsheetUrl is too long' })
  spreadsheetUrl: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'sheetName must not be empty when provided' })
  sheetName?: string;
}
