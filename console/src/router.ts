import { createRouter, createWebHistory } from "vue-router";
import FeedView from "./views/FeedView.vue";
import AgentsView from "./views/AgentsView.vue";
import PlaygroundView from "./views/PlaygroundView.vue";

export const router = createRouter({
  history: createWebHistory("/console/"),
  routes: [
    { path: "/", redirect: "/feed" },
    { path: "/feed", component: FeedView },
    { path: "/agents", component: AgentsView },
    { path: "/playground", component: PlaygroundView },
  ],
});
