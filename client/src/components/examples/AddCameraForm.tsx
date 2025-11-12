import AddCameraForm from "../AddCameraForm";

export default function AddCameraFormExample() {
  return (
    <div className="p-6 bg-background min-h-screen">
      <AddCameraForm
        onSave={(camera) => console.log("Save camera:", camera)}
        onCancel={() => console.log("Cancel clicked")}
      />
    </div>
  );
}
