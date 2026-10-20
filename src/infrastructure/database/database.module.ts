import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "./mikro-orm.config";

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: () => MikroORM.init(createOrmConfig()),
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
