"""Render the coach run cycle from the CC0 Quaternius Universal Animation Library.

Run with Blender (headless):
  blender -b -P tools/render_coach.py -- <glb> <out_dir> [frames=24]

Renders `Jog_Fwd_Loop` of the mannequin from the side with Workbench, one
greyscale+alpha PNG per phase sample, into <out_dir>/f00.png ...
Also writes <out_dir>/meta.txt with the cycle length (frames at 30 fps) and
the frame at which each foot is lowest (foot strike estimate).
"""
import sys
import bpy
import math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
glb, out_dir = argv[0], argv[1]
count = int(argv[2]) if len(argv) > 2 else 24

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.name == 'Mannequin')
for o in bpy.data.objects:
    if o.type == 'MESH' and o is not mesh:
        o.hide_render = True
        o.hide_viewport = True

action = bpy.data.actions['Jog_Fwd_Loop']
arm.animation_data.action = action
start, end = action.frame_range
cycle = end - start
print('CYCLE', start, end, cycle)

scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.resolution_x = 360
scene.render.resolution_y = 480
scene.render.resolution_percentage = 100
shading = scene.display.shading
shading.light = 'STUDIO'
shading.color_type = 'SINGLE'
shading.single_color = (0.8, 0.8, 0.8)
shading.show_cavity = False
shading.show_object_outline = False
scene.display.shading.show_specular_highlight = False
try:
    scene.view_settings.view_transform = 'Standard'
except Exception:
    pass

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 2.4
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
# Side view: camera on the -X side looking +X; the runner moves toward +Y in
# Blender, so on screen it is running to the left or right depending on the
# side. SIDE is chosen so that the runner faces screen-right.
side = -1.0
cam.location = (side * 6.0, 0.0, 0.95)
cam.rotation_euler = (math.radians(90), 0, math.radians(-90 if side < 0 else 90))

light = bpy.data.lights.new('l', 'SUN')
lobj = bpy.data.objects.new('l', light)
scene.collection.objects.link(lobj)

foot_info = []
for i in range(count):
    f = start + cycle * i / count
    scene.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
    bpy.context.view_layer.update()
    scene.render.filepath = '%s/f%02d.png' % (out_dir, i)
    bpy.ops.render.render(write_still=True)
    lf = arm.pose.bones.get('foot_l')
    rf = arm.pose.bones.get('foot_r')
    if lf and rf:
        lz = (arm.matrix_world @ lf.head).z
        rz = (arm.matrix_world @ rf.head).z
        foot_info.append((i, round(lz, 3), round(rz, 3)))

with open(out_dir + '/meta.txt', 'w') as fh:
    fh.write('cycle_frames_30fps=%s\n' % cycle)
    for row in foot_info:
        fh.write('%s\n' % (row,))
print('DONE')
