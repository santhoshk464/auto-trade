import { Transform } from 'class-transformer';
import { IsEnum, IsString, MinLength } from 'class-validator';

export enum BrokerTypeDto {
  KITE = 'KITE',
  ANGEL = 'ANGEL',
  DELTA = 'DELTA',
}

export class CreateBrokerDto {
  @IsEnum(BrokerTypeDto)
  type!: BrokerTypeDto;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  apiKey!: string;

  @IsString()
  @MinLength(4)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  apiSecret!: string;
}
