import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CampaignModule } from './modules/campaign';
import { EmailModule } from './modules/email';
import { GoogleSheetModule } from './modules/google-sheet';
import { configurations } from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
      envFilePath: ['.env.local', '.env'],
    }),
    GoogleSheetModule,
    CampaignModule,
    EmailModule,
  ],
})
export class AppModule {}
