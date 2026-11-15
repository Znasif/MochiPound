Moon Rabbit player characters

Copied unchanged from the MochiPound repository, origin/multiplayer:
  Assets/Mochi_Player_Rabbit.glb
  Assets/Mochi_Player_Rabbit_Red.glb

These are the rigged player rabbits (indigo and red work jackets), not the Moon Rabbit sign
or the unrelated skateboard-bunny prop. Both GLBs embed their materials and skeleton;
no external textures, animation clips, converters or remote asset services are required.

Source revision: 67d1c6544b1ed3957459871e5190c0b2f9bc9030

src/rabbitAvatar.js drives the existing head, arm and leg bones from multiplayer poses.
Left and right hands/controllers move independently, including wrist rotation; the head
turns separately from the torso. Alternating planted steps follow world travel, whether
it comes from physical walking or a joystick. Crouching bends the knees. Teleports reset
the gait. Foot movement is estimated from headset travel, not tracked foot input.
The host appears in red; the joining player appears in indigo. Physics still uses the
tracked hand joints and station mallet shapes.
