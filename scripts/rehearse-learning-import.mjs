// Node 22.18+ / 24+. Read-only: does not connect to a database or expose answers.
import { readFileSync } from "node:fs";
import { prepareLearningImport } from "../src/imports/learningImport.ts";
const [snapshotPath, productsPath, mediaPath] = process.argv.slice(2);
if (!snapshotPath || !productsPath) throw new Error("Usage: node scripts/rehearse-learning-import.mjs snapshot.json product-ids.json [approved-media-map.json]");
const snapshot = JSON.parse(readFileSync(snapshotPath,"utf8"));
const productIds = JSON.parse(readFileSync(productsPath,"utf8"));
const media = mediaPath ? JSON.parse(readFileSync(mediaPath,"utf8")) : {};
const imports = prepareLearningImport(snapshot,productIds,media);
console.log(JSON.stringify({ courses: imports.length, units: imports.reduce((n,c) => n+c.document.units.length,0), quizQuestions: imports.reduce((n,c) => n+c.document.units.reduce((count,u) => count+(u.type === "quiz" ? u.questions.length : 0),0),0), pendingVideos: imports.reduce((n,c) => n+c.pendingVideoIds.length,0), coursesReadyForReview: imports.filter(c => !c.pendingVideoIds.length).length },null,2));
