export const TRAINING_OPEN_TOPIC = "brainpet.training/open";

export async function openTraining(ctx, source = "pet-command") {
  await ctx.bus.publish(TRAINING_OPEN_TOPIC, { source });
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register({
        id: "train",
        title: "$t:command.train.title",
        description: "$t:command.train.description",
        placement: "top",
        priority: 1000,
        featured: true
      }, () => openTraining(ctx));
    },
    async stop() {}
  });
}
