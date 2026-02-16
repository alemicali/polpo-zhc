// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import '/flutter_flow/flutter_flow_util.dart';

class WorkerDataStruct extends FFFirebaseStruct {
  WorkerDataStruct({
    String? name,
    String? surname,
    DocumentReference? ref,
    String? displayName,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _name = name,
        _surname = surname,
        _ref = ref,
        _displayName = displayName,
        super(firestoreUtilData);

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  set name(String? val) => _name = val;

  bool hasName() => _name != null;

  // "surname" field.
  String? _surname;
  String get surname => _surname ?? '';
  set surname(String? val) => _surname = val;

  bool hasSurname() => _surname != null;

  // "ref" field.
  DocumentReference? _ref;
  DocumentReference? get ref => _ref;
  set ref(DocumentReference? val) => _ref = val;

  bool hasRef() => _ref != null;

  // "display_name" field.
  String? _displayName;
  String get displayName => _displayName ?? '';
  set displayName(String? val) => _displayName = val;

  bool hasDisplayName() => _displayName != null;

  static WorkerDataStruct fromMap(Map<String, dynamic> data) =>
      WorkerDataStruct(
        name: data['name'] as String?,
        surname: data['surname'] as String?,
        ref: data['ref'] as DocumentReference?,
        displayName: data['display_name'] as String?,
      );

  static WorkerDataStruct? maybeFromMap(dynamic data) => data is Map
      ? WorkerDataStruct.fromMap(data.cast<String, dynamic>())
      : null;

  Map<String, dynamic> toMap() => {
        'name': _name,
        'surname': _surname,
        'ref': _ref,
        'display_name': _displayName,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'name': serializeParam(
          _name,
          ParamType.String,
        ),
        'surname': serializeParam(
          _surname,
          ParamType.String,
        ),
        'ref': serializeParam(
          _ref,
          ParamType.DocumentReference,
        ),
        'display_name': serializeParam(
          _displayName,
          ParamType.String,
        ),
      }.withoutNulls;

  static WorkerDataStruct fromSerializableMap(Map<String, dynamic> data) =>
      WorkerDataStruct(
        name: deserializeParam(
          data['name'],
          ParamType.String,
          false,
        ),
        surname: deserializeParam(
          data['surname'],
          ParamType.String,
          false,
        ),
        ref: deserializeParam(
          data['ref'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['workers'],
        ),
        displayName: deserializeParam(
          data['display_name'],
          ParamType.String,
          false,
        ),
      );

  static WorkerDataStruct fromAlgoliaData(Map<String, dynamic> data) =>
      WorkerDataStruct(
        name: convertAlgoliaParam(
          data['name'],
          ParamType.String,
          false,
        ),
        surname: convertAlgoliaParam(
          data['surname'],
          ParamType.String,
          false,
        ),
        ref: convertAlgoliaParam(
          data['ref'],
          ParamType.DocumentReference,
          false,
        ),
        displayName: convertAlgoliaParam(
          data['display_name'],
          ParamType.String,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'WorkerDataStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    return other is WorkerDataStruct &&
        name == other.name &&
        surname == other.surname &&
        ref == other.ref &&
        displayName == other.displayName;
  }

  @override
  int get hashCode =>
      const ListEquality().hash([name, surname, ref, displayName]);
}

WorkerDataStruct createWorkerDataStruct({
  String? name,
  String? surname,
  DocumentReference? ref,
  String? displayName,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    WorkerDataStruct(
      name: name,
      surname: surname,
      ref: ref,
      displayName: displayName,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

WorkerDataStruct? updateWorkerDataStruct(
  WorkerDataStruct? workerData, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    workerData
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addWorkerDataStructData(
  Map<String, dynamic> firestoreData,
  WorkerDataStruct? workerData,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (workerData == null) {
    return;
  }
  if (workerData.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields =
      !forFieldValue && workerData.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final workerDataData = getWorkerDataFirestoreData(workerData, forFieldValue);
  final nestedData = workerDataData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields = workerData.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getWorkerDataFirestoreData(
  WorkerDataStruct? workerData, [
  bool forFieldValue = false,
]) {
  if (workerData == null) {
    return {};
  }
  final firestoreData = mapToFirestore(workerData.toMap());

  // Add any Firestore field values
  workerData.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getWorkerDataListFirestoreData(
  List<WorkerDataStruct>? workerDatas,
) =>
    workerDatas?.map((e) => getWorkerDataFirestoreData(e, true)).toList() ?? [];
