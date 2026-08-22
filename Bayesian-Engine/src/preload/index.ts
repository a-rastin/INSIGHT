import { contextBridge } from "electron";
import { bayesEngineApi } from "./api";

contextBridge.exposeInMainWorld("bayesEngine", bayesEngineApi);
