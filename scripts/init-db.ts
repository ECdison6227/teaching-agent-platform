import "./env";
import { database } from "../src/db";
import { dataDir } from "../src/lib/storage";
database();
console.log(`数据库已初始化：${dataDir()}/platform.sqlite`);
