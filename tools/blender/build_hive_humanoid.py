"""Build the Hive Chameleon humanoid and hunter rifle in Blender.

Run inside Blender. The script saves the editable .blend source, exports the
runtime FBX files directly into the Unity project, and renders a studio preview.
"""

import math
import os

import bpy
from mathutils import Vector


def find_project_root():
    configured = os.environ.get("HIVE_CHAMELEON_ROOT")
    starts = [configured, os.getcwd()]
    if bpy.data.filepath:
        starts.append(os.path.dirname(bpy.data.filepath))
    script_path = globals().get("__file__")
    if script_path:
        starts.append(os.path.dirname(os.path.abspath(script_path)))

    for start in starts:
        if not start:
            continue
        candidate = os.path.abspath(start)
        for _ in range(10):
            if os.path.isdir(os.path.join(candidate, "clients", "unity")):
                return candidate
            parent = os.path.dirname(candidate)
            if parent == candidate:
                break
            candidate = parent

    raise RuntimeError(
        "Hive Chameleon project root was not found. "
        "Set HIVE_CHAMELEON_ROOT before running this script."
    )


PROJECT_ROOT = find_project_root()
SOURCE_DIR = os.path.join(PROJECT_ROOT, "art", "blender")
UNITY_MODEL_DIR = os.path.join(
    PROJECT_ROOT,
    "clients",
    "unity",
    "Assets",
    "HiveChameleon",
    "Art",
    "Models",
)
PREVIEW_PATH = os.path.expanduser(
    "~/Documents/Hive Chameleon Humanoid Preview.png"
)
BLEND_PATH = os.path.join(SOURCE_DIR, "HiveHumanoid.blend")
HUMANOID_FBX_PATH = os.path.join(UNITY_MODEL_DIR, "HC_Humanoid.fbx")
RIFLE_FBX_PATH = os.path.join(UNITY_MODEL_DIR, "HC_HunterRifle.fbx")


def ensure_directories():
    os.makedirs(SOURCE_DIR, exist_ok=True)
    os.makedirs(UNITY_MODEL_DIR, exist_ok=True)


def clear_scene():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for existing_collection in list(bpy.data.collections):
        bpy.data.collections.remove(existing_collection)

    base_collection = bpy.data.collections.new("Presentation")
    bpy.context.scene.collection.children.link(base_collection)


def collection(name):
    existing = bpy.data.collections.get(name)
    if existing:
        return existing
    value = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(value)
    return value


def move_to_collection(obj, target):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    target.objects.link(obj)


def material(name, color, metallic=0.0, roughness=0.5):
    value = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    value.diffuse_color = color
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    if shader:
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Metallic"].default_value = metallic
        shader.inputs["Roughness"].default_value = roughness
    return value


def finish_mesh(obj, mat, bevel=0.0, smooth=False):
    if mat:
        obj.data.materials.append(mat)

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    if bevel > 0.0:
        modifier = obj.modifiers.new("Soft bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
        modifier.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True

    obj.select_set(False)
    return obj


def rounded_box(name, position, dimensions, mat, owner, bevel=0.035, rotation=None):
    bpy.ops.mesh.primitive_cube_add(location=position)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    if rotation:
        obj.rotation_euler = rotation
    move_to_collection(obj, owner)
    return finish_mesh(obj, mat, bevel=bevel, smooth=False)


def sphere(name, position, scale, mat, owner, segments=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        location=position,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    move_to_collection(obj, owner)
    return finish_mesh(obj, mat, smooth=True)


def tapered_limb(
    name,
    start,
    end,
    radius_start,
    radius_end,
    mat,
    owner,
    bevel=0.012,
):
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = end_vector - start_vector
    length = direction.length
    midpoint = (start_vector + end_vector) * 0.5
    rotation = direction.to_track_quat("Z", "Y").to_euler()
    bpy.ops.mesh.primitive_cone_add(
        vertices=16,
        radius1=radius_end,
        radius2=radius_start,
        depth=length,
        location=midpoint,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    move_to_collection(obj, owner)
    return finish_mesh(obj, mat, bevel=bevel, smooth=True)


def assign_to_bone(obj, armature, bone_name):
    obj.parent = armature
    group = obj.vertex_groups.new(name=bone_name)
    group.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    modifier = obj.modifiers.new("Humanoid rig", "ARMATURE")
    modifier.object = armature


def create_armature(owner):
    data = bpy.data.armatures.new("HC_Humanoid_Armature")
    armature = bpy.data.objects.new("HC_Humanoid_Rig", data)
    owner.objects.link(armature)
    armature.show_in_front = True

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    bones = {}

    def add_bone(name, head, tail, parent=None, connected=False):
        bone = data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if parent:
            bone.parent = bones[parent]
            bone.use_connect = connected
        bones[name] = bone

    add_bone("Root", (0, 0, 0), (0, 0, 0.1))
    add_bone("Hips", (0, 0, 0.91), (0, 0, 1.04), "Root")
    add_bone("Spine", (0, 0, 1.04), (0, 0, 1.23), "Hips", True)
    add_bone("Chest", (0, 0, 1.23), (0, 0, 1.45), "Spine", True)
    add_bone("Neck", (0, 0, 1.45), (0, 0, 1.54), "Chest", True)
    add_bone("Head", (0, 0, 1.54), (0, 0, 1.79), "Neck", True)

    add_bone("LeftShoulder", (0, 0, 1.42), (-0.16, 0, 1.4), "Chest")
    add_bone(
        "LeftUpperArm",
        (-0.16, 0, 1.4),
        (-0.32, 0, 1.16),
        "LeftShoulder",
        True,
    )
    add_bone(
        "LeftLowerArm",
        (-0.32, 0, 1.16),
        (-0.34, 0, 0.91),
        "LeftUpperArm",
        True,
    )
    add_bone(
        "LeftHand",
        (-0.34, 0, 0.91),
        (-0.34, -0.03, 0.76),
        "LeftLowerArm",
        True,
    )

    add_bone("RightShoulder", (0, 0, 1.42), (0.16, 0, 1.4), "Chest")
    add_bone(
        "RightUpperArm",
        (0.16, 0, 1.4),
        (0.32, 0, 1.16),
        "RightShoulder",
        True,
    )
    add_bone(
        "RightLowerArm",
        (0.32, 0, 1.16),
        (0.34, 0, 0.91),
        "RightUpperArm",
        True,
    )
    add_bone(
        "RightHand",
        (0.34, 0, 0.91),
        (0.34, -0.03, 0.76),
        "RightLowerArm",
        True,
    )

    add_bone(
        "LeftUpperLeg",
        (-0.12, 0, 0.96),
        (-0.12, 0, 0.54),
        "Hips",
    )
    add_bone(
        "LeftLowerLeg",
        (-0.12, 0, 0.54),
        (-0.12, 0, 0.12),
        "LeftUpperLeg",
        True,
    )
    add_bone(
        "LeftFoot",
        (-0.12, 0, 0.12),
        (-0.12, -0.2, 0.055),
        "LeftLowerLeg",
        True,
    )
    add_bone(
        "RightUpperLeg",
        (0.12, 0, 0.96),
        (0.12, 0, 0.54),
        "Hips",
    )
    add_bone(
        "RightLowerLeg",
        (0.12, 0, 0.54),
        (0.12, 0, 0.12),
        "RightUpperLeg",
        True,
    )
    add_bone(
        "RightFoot",
        (0.12, 0, 0.12),
        (0.12, -0.2, 0.055),
        "RightLowerLeg",
        True,
    )

    bpy.ops.object.mode_set(mode="OBJECT")
    armature.select_set(False)
    return armature


def create_humanoid(owner, mats):
    armature = create_armature(owner)
    body = mats["body"]
    secondary = mats["secondary"]
    visor = mats["visor"]
    accent = mats["accent"]

    parts = []

    def add(obj, bone):
        assign_to_bone(obj, armature, bone)
        parts.append(obj)
        return obj

    add(
        sphere(
            "Pelvis",
            (0, 0, 0.96),
            (0.22, 0.14, 0.16),
            secondary,
            owner,
            24,
            16,
        ),
        "Hips",
    )
    add(
        sphere(
            "Abdomen",
            (0, 0, 1.105),
            (0.2, 0.125, 0.19),
            body,
            owner,
            24,
            16,
        ),
        "Spine",
    )
    add(
        sphere(
            "Chest",
            (0, 0, 1.3),
            (0.29, 0.15, 0.29),
            body,
            owner,
            28,
            18,
        ),
        "Chest",
    )
    add(
        tapered_limb(
            "Neck shell",
            (0, 0, 1.45),
            (0, 0, 1.55),
            0.085,
            0.075,
            secondary,
            owner,
            0.008,
        ),
        "Neck",
    )
    add(
        sphere(
            "Head",
            (0, -0.012, 1.68),
            (0.16, 0.15, 0.205),
            body,
            owner,
            32,
            20,
        ),
        "Head",
    )

    for side_name, sign in (("Left", -1.0), ("Right", 1.0)):
        shoulder_x = sign * 0.17
        elbow_x = sign * 0.32
        wrist_x = sign * 0.34
        hand_x = sign * 0.34

        add(
            sphere(
                f"{side_name} shoulder cap",
                (shoulder_x, 0, 1.4),
                (0.13, 0.125, 0.13),
                body,
                owner,
                20,
                14,
            ),
            "Chest",
        )
        add(
            tapered_limb(
                f"{side_name} upper arm",
                (sign * 0.18, 0, 1.39),
                (sign * 0.31, 0, 1.18),
                0.1,
                0.082,
                body,
                owner,
            ),
            f"{side_name}UpperArm",
        )
        add(
            sphere(
                f"{side_name} elbow",
                (elbow_x, 0, 1.15),
                (0.083, 0.083, 0.083),
                secondary,
                owner,
                18,
                12,
            ),
            f"{side_name}LowerArm",
        )
        add(
            tapered_limb(
                f"{side_name} forearm",
                (sign * 0.32, 0, 1.12),
                (sign * 0.34, 0, 0.93),
                0.082,
                0.068,
                body,
                owner,
            ),
            f"{side_name}LowerArm",
        )
        add(
            rounded_box(
                f"{side_name} wrist band",
                (wrist_x, 0, 0.92),
                (0.13, 0.12, 0.055),
                accent,
                owner,
                0.02,
            ),
            f"{side_name}LowerArm",
        )
        add(
            rounded_box(
                f"{side_name} hand",
                (hand_x, -0.01, 0.83),
                (0.13, 0.11, 0.17),
                body,
                owner,
                0.035,
            ),
            f"{side_name}Hand",
        )

        hip_x = sign * 0.12
        add(
            tapered_limb(
                f"{side_name} thigh",
                (hip_x, 0, 0.93),
                (hip_x, 0, 0.57),
                0.145,
                0.105,
                body,
                owner,
                0.018,
            ),
            f"{side_name}UpperLeg",
        )
        add(
            sphere(
                f"{side_name} knee",
                (hip_x, -0.005, 0.54),
                (0.115, 0.108, 0.11),
                secondary,
                owner,
                20,
                14,
            ),
            f"{side_name}LowerLeg",
        )
        add(
            tapered_limb(
                f"{side_name} calf",
                (hip_x, 0, 0.5),
                (hip_x, 0, 0.15),
                0.105,
                0.075,
                body,
                owner,
                0.015,
            ),
            f"{side_name}LowerLeg",
        )
        add(
            rounded_box(
                f"{side_name} ankle band",
                (hip_x, 0, 0.155),
                (0.15, 0.14, 0.07),
                accent,
                owner,
                0.025,
            ),
            f"{side_name}LowerLeg",
        )
        add(
            rounded_box(
                f"{side_name} boot",
                (hip_x, -0.095, 0.075),
                (0.19, 0.31, 0.14),
                secondary,
                owner,
                0.045,
            ),
            f"{side_name}Foot",
        )

    return armature, parts


def create_rifle(owner, mats):
    gunmetal = mats["gunmetal"]
    gun_dark = mats["gun_dark"]
    accent = mats["accent"]

    root = bpy.data.objects.new("HC_HunterRifle", None)
    owner.objects.link(root)
    parts = []

    def add(obj):
        obj.parent = root
        parts.append(obj)
        return obj

    add(
        rounded_box(
            "Receiver",
            (0, -0.07, 0.1),
            (0.16, 0.38, 0.17),
            gunmetal,
            owner,
            0.035,
        )
    )
    add(
        rounded_box(
            "Receiver inset",
            (0, -0.135, 0.105),
            (0.171, 0.17, 0.075),
            gun_dark,
            owner,
            0.018,
        )
    )
    add(
        tapered_limb(
            "Barrel",
            (0, -0.25, 0.105),
            (0, -0.67, 0.105),
            0.04,
            0.029,
            gun_dark,
            owner,
            0.006,
        )
    )
    add(
        tapered_limb(
            "Muzzle",
            (0, -0.64, 0.105),
            (0, -0.75, 0.105),
            0.055,
            0.055,
            gunmetal,
            owner,
            0.008,
        )
    )
    add(
        rounded_box(
            "Stock",
            (0, 0.205, 0.12),
            (0.14, 0.28, 0.15),
            gunmetal,
            owner,
            0.035,
        )
    )
    add(
        rounded_box(
            "Shoulder pad",
            (0, 0.37, 0.12),
            (0.17, 0.075, 0.19),
            gun_dark,
            owner,
            0.027,
        )
    )
    add(
        rounded_box(
            "Grip",
            (0, 0.045, -0.035),
            (0.095, 0.12, 0.23),
            gun_dark,
            owner,
            0.027,
            (math.radians(-12), 0, 0),
        )
    )
    add(
        rounded_box(
            "Magazine",
            (0, -0.09, -0.045),
            (0.105, 0.14, 0.24),
            gunmetal,
            owner,
            0.022,
            (math.radians(7), 0, 0),
        )
    )
    add(
        rounded_box(
            "Top rail",
            (0, -0.075, 0.205),
            (0.11, 0.31, 0.045),
            gun_dark,
            owner,
            0.01,
        )
    )
    add(
        rounded_box(
            "Sight",
            (0, -0.12, 0.255),
            (0.08, 0.105, 0.07),
            gun_dark,
            owner,
            0.018,
        )
    )
    add(
        rounded_box(
            "Sight lens",
            (0, -0.176, 0.258),
            (0.045, 0.012, 0.032),
            accent,
            owner,
            0.008,
        )
    )
    add(
        rounded_box(
            "Hand guard",
            (0, -0.32, 0.09),
            (0.135, 0.22, 0.13),
            gunmetal,
            owner,
            0.03,
        )
    )
    return root, parts


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build_presentation(humanoid_root, rifle_root, owner, mats):
    rifle_root.location = (0.78, -0.04, 0.82)
    rifle_root.rotation_euler = (math.radians(8), math.radians(-12), math.radians(-8))

    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.005))
    floor = bpy.context.object
    floor.name = "Studio floor"
    move_to_collection(floor, owner)
    floor.data.materials.append(mats["floor"])

    backdrop = rounded_box(
        "Backdrop",
        (0, 1.4, 1.25),
        (5.2, 0.08, 2.5),
        mats["backdrop"],
        owner,
        0.04,
    )
    backdrop.rotation_euler[0] = math.radians(2)

    camera_data = bpy.data.cameras.new("Studio Camera")
    camera = bpy.data.objects.new("Studio Camera", camera_data)
    owner.objects.link(camera)
    bpy.context.scene.camera = camera
    camera.location = (3.15, -5.4, 2.25)
    camera.data.lens = 58
    look_at(camera, (0.05, 0, 1.0))

    def area_light(name, position, energy, size, color):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        light = bpy.data.objects.new(name, data)
        owner.objects.link(light)
        light.location = position
        look_at(light, (0, 0, 1.0))

    area_light("Key light", (-2.4, -3.2, 4.1), 1100, 3.0, (0.72, 0.86, 1.0))
    area_light("Fill light", (3.1, -1.4, 2.2), 850, 2.2, (1.0, 0.58, 0.32))
    area_light("Rim light", (0.5, 2.8, 3.6), 1200, 2.0, (0.25, 0.55, 1.0))


def export_fbx(objects, filepath, include_armature):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]

    object_types = {"MESH", "EMPTY"}
    if include_armature:
        object_types.add("ARMATURE")

    bpy.ops.export_scene.fbx(
        filepath=filepath,
        use_selection=True,
        object_types=object_types,
        apply_unit_scale=True,
        global_scale=1.0,
        axis_forward="-Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=False,
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
    )
    bpy.ops.object.select_all(action="DESELECT")


def render_preview():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = PREVIEW_PATH
    scene.render.film_transparent = False
    scene.world.color = (0.018, 0.025, 0.04)

    scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.ops.render.render(write_still=True)


def main():
    ensure_directories()
    clear_scene()

    humanoid_collection = collection("Humanoid")
    weapon_collection = collection("Weapons")
    presentation_collection = bpy.data.collections["Presentation"]

    materials = {
        "body": material("HC Body White", (0.86, 0.88, 0.89, 1.0), 0.03, 0.34),
        "secondary": material(
            "HC Joint Graphite",
            (0.3, 0.34, 0.39, 1.0),
            0.3,
            0.34,
        ),
        "visor": material("HC Visor", (0.008, 0.022, 0.035, 1.0), 0.7, 0.12),
        "accent": material("HC Player Color", (0.035, 0.86, 0.72, 1.0), 0.25, 0.24),
        "gunmetal": material(
            "HC Gunmetal",
            (0.055, 0.075, 0.105, 1.0),
            0.72,
            0.23,
        ),
        "gun_dark": material(
            "HC Gun Dark",
            (0.012, 0.018, 0.028, 1.0),
            0.55,
            0.32,
        ),
        "floor": material("Studio Floor", (0.035, 0.045, 0.06, 1.0), 0.05, 0.62),
        "backdrop": material(
            "Studio Backdrop",
            (0.055, 0.08, 0.12, 1.0),
            0.02,
            0.72,
        ),
    }

    humanoid_root, humanoid_parts = create_humanoid(humanoid_collection, materials)
    rifle_root, rifle_parts = create_rifle(weapon_collection, materials)

    # Export from the neutral T-pose before presentation posing.
    export_fbx(
        [humanoid_root] + humanoid_parts,
        HUMANOID_FBX_PATH,
        include_armature=True,
    )
    export_fbx([rifle_root] + rifle_parts, RIFLE_FBX_PATH, include_armature=False)

    build_presentation(
        humanoid_root,
        rifle_root,
        presentation_collection,
        materials,
    )
    render_preview()
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)

    print(
        {
            "blend": BLEND_PATH,
            "humanoid_fbx": HUMANOID_FBX_PATH,
            "rifle_fbx": RIFLE_FBX_PATH,
            "preview": PREVIEW_PATH,
            "humanoid_parts": len(humanoid_parts),
            "rifle_parts": len(rifle_parts),
        }
    )


main()
